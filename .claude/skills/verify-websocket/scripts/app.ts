// The app under verification: a server built on the library the way a user
// would build one. launch.ts starts it in the background; don't run it by hand.
//
// Routes (impl "ours"):
//   /echo             echoes text and binary messages
//   /close            the server closes at once with ?code=&reason=
//   /rooms/:id        JSON messages: {"type":"say","data":...} answers "said",
//                     any other type answers "unknown"
//   /private          echo, but needs ?token=secret (else 401); ?delay=<ms>
//                     waits before answering
//   anything else     404
// Impl "ws" (the reference library) echoes on every path.
//
// Every request, connection, message and close goes to server-events.jsonl.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { WebSocketServer as WsServer } from "ws";

import type { WebSocketConnection } from "../../../../lib/web-socket-connection.ts";
import {
  MessageRouter,
  WebSocketRouter,
} from "../../../../lib/web-socket-router.ts";
import { WebSocketServer } from "../../../../lib/web-socket-server.ts";
import {
  fixtureCert,
  fixtureKey,
  repoRoot,
  runDir,
  statePath,
  type ServerState,
} from "./common.ts";

const { values: args } = parseArgs({
  options: {
    run: { type: "string" },
    impl: { type: "string", default: "ours" },
    port: { type: "string", default: "0" },
    tls: { type: "boolean", default: false },
    deflate: { type: "boolean", default: false },
    "max-message-size": { type: "string" },
  },
});

const run = args.run ?? "";
const impl = args.impl === "ws" ? "ws" : "ours";
const maxMessageSize = args["max-message-size"]
  ? Number(args["max-message-size"])
  : null;
const eventsFile = path.join(runDir(run), "server-events.jsonl");

function event(kind: string, details: Record<string, unknown> = {}) {
  appendFileSync(
    eventsFile,
    JSON.stringify({ t: new Date().toISOString(), kind, ...details }) + "\n",
  );
}

function preview(payload: string | Buffer) {
  return typeof payload === "string"
    ? { bytes: Buffer.byteLength(payload), text: payload.slice(0, 80) }
    : { bytes: payload.length, hex: payload.subarray(0, 32).toString("hex") };
}

const httpServer: Server = args.tls
  ? createHttpsServer({
      cert: readFileSync(fixtureCert),
      key: readFileSync(fixtureKey),
    })
  : createHttpServer();

if (impl === "ours") {
  const wsServer = new WebSocketServer(httpServer, {
    perMessageDeflate: args.deflate,
    ...(maxMessageSize === null ? {} : { maxMessageSize }),
  });
  const router = new WebSocketRouter();

  const echo = (connection: WebSocketConnection) => {
    connection.on("message", (message) =>
      connection.send("text", message.payload),
    );
    connection.on("binaryMessage", (message) =>
      connection.send("binary", message.payload),
    );
  };
  router.route("/echo", echo);
  router.route("/private", echo);
  router.route("/close", (connection, { query }) => {
    connection.close(
      Number(query.get("code") ?? 1000),
      query.get("reason") ?? "",
    );
  });
  router.route("/rooms/:id", (connection, { params, query }) => {
    const messages = new MessageRouter(connection);
    messages.on("say", (data) => {
      messages.send("said", {
        room: params["id"],
        from: query.get("name"),
        text: data,
      });
    });
    messages.fallback((_data, type) => messages.send("unknown", { type }));
  });

  wsServer.on("request", async (request) => {
    event("request", {
      path: request.path,
      query: request.query.toString(),
      extensionsOffered: request.headers["sec-websocket-extensions"] ?? null,
    });
    request.on("close", () => event("request-gone", { path: request.path }));
    try {
      if (request.path === "/private") {
        const delay = Number(request.query.get("delay") ?? 0);
        if (delay > 0) await sleep(delay);
        if (request.query.get("token") !== "secret") {
          if (!request.closed)
            event("reject", { path: request.path, status: 401 });
          request.reject(401, "Missing or wrong token");
          return;
        }
      }
      router.handle(request);
    } catch (error) {
      // the router already closed the connection with 1011
      event("handler-error", { message: String(error) });
    }
  });

  wsServer.on("connect", (connection) => {
    event("connect", { path: connection.path });
    connection.on("message", (m) =>
      event("message", { path: connection.path, ...preview(m.payload) }),
    );
    connection.on("binaryMessage", (m) =>
      event("binary", { path: connection.path, ...preview(m.payload) }),
    );
    connection.on("pong", (payload) => event("pong", preview(payload)));
    connection.on("close", (code, reason) =>
      event("close", { path: connection.path, code, reason }),
    );
  });
} else {
  const wsServer = new WsServer({
    server: httpServer,
    perMessageDeflate: args.deflate,
    ...(maxMessageSize === null ? {} : { maxPayload: maxMessageSize }),
  });
  wsServer.on("connection", (socket, request) => {
    const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
    event("connect", {
      path: urlPath,
      extensionsOffered: request.headers["sec-websocket-extensions"] ?? null,
    });
    socket.on("error", () => {});
    socket.on("message", (data, isBinary) => {
      const payload = Buffer.isBuffer(data)
        ? data
        : Buffer.concat(data as Buffer[]);
      event(isBinary ? "binary" : "message", {
        path: urlPath,
        ...preview(isBinary ? payload : payload.toString("utf8")),
      });
      socket.send(payload, { binary: isBinary });
    });
    socket.on("close", (code, reason) =>
      event("close", { path: urlPath, code, reason: reason.toString() }),
    );
  });
}

function git(...gitArgs: string[]) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

process.on("SIGTERM", () => {
  event("shutdown", { signal: "SIGTERM" });
  process.exit(0);
});

httpServer.listen(Number(args.port), "127.0.0.1", () => {
  const { port } = httpServer.address() as AddressInfo;
  const state: ServerState = {
    run,
    pid: process.pid,
    impl,
    port,
    // the certificate is issued for localhost, not 127.0.0.1
    url: `${args.tls ? "wss" : "ws"}://${args.tls ? "localhost" : "127.0.0.1"}:${port}`,
    tls: args.tls,
    deflate: args.deflate,
    maxMessageSize,
    revision: git("rev-parse", "--short", "HEAD"),
    dirty:
      git("status", "--porcelain", "--untracked-files=no", "--", "lib").length >
      0,
    startedAt: new Date().toISOString(),
  };
  // written in one step, so launch.ts never reads half a file
  writeFileSync(`${statePath(run)}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${statePath(run)}.tmp`, statePath(run));
  event("listening", {
    url: state.url,
    impl,
    deflate: args.deflate,
    tls: args.tls,
  });
  console.log(`listening on ${state.url}`);
});
