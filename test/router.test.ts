// Tests for WebSocketRouter (connections by path) and MessageRouter (JSON
// messages by type). Each suite starts its own server on a free port and
// talks to it with the real client.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import type { WebSocketConnection } from "../lib/web-socket-connection.ts";
import {
  MessageRouter,
  WebSocketRouter,
  type RouteContext,
} from "../lib/web-socket-router.ts";
import { WebSocketServer } from "../lib/web-socket-server.ts";
import { connect, handshake, listen, nextText } from "./helpers.ts";

type Routed = {
  name: string;
  connection: WebSocketConnection;
  context: RouteContext;
};

describe("WebSocketRouter", () => {
  let httpServer: Server;
  let wsServer: WebSocketServer;
  let port: number;
  let url: string;
  // every handler call, in order
  const routed: Routed[] = [];
  // every "connect" event, with how many handlers had run by then
  const connected: { connection: WebSocketConnection; handlers: number }[] = [];

  before(async () => {
    httpServer = createServer();
    wsServer = new WebSocketServer(httpServer);
    wsServer.on("connect", (connection) =>
      connected.push({ connection, handlers: routed.length }),
    );

    const record = (name: string) => {
      return (connection: WebSocketConnection, context: RouteContext) => {
        routed.push({ name, connection, context });
      };
    };

    new WebSocketRouter(wsServer)
      .route("/rooms/lobby", record("lobby"))
      .route("/rooms/:id", record("room"))
      .route("/files/:folder/:name", record("file"))
      .route("/", record("root"));

    port = await listen(httpServer);
    url = `ws://127.0.0.1:${port}`;
  });

  after(() => {
    httpServer.close();
  });

  /** Connects, waits for the route handler and returns its call. */
  async function open(path: string) {
    const before = routed.length;
    const client = await connect(url + path);
    const call = routed[before];
    assert.ok(call, `no handler ran for ${path}`);
    return { client, ...call };
  }

  test("an unknown path gets 404 and never a 101", async () => {
    const answer = await handshake(port, "/nowhere");
    assert.equal(answer.status, 404);
    assert.equal(answer.body, "Not Found");

    await assert.rejects(connect(`${url}/nowhere`), /got status 404/);
  });

  test("/rooms/42 reaches its handler with { id: '42' }", async () => {
    const { client, name, connection, context } = await open("/rooms/42");
    assert.equal(name, "room");
    assert.deepEqual(context.params, { id: "42" });
    assert.equal(connection.path, "/rooms/42");
    client.close();
  });

  test("the handler gets the query", async () => {
    const { client, context } = await open("/rooms/42?name=Ada");
    assert.equal(context.query.get("name"), "Ada");
    assert.equal(context.request.path, "/rooms/42");
    client.close();
  });

  test("the first matching route wins", async () => {
    const { client, name, context } = await open("/rooms/lobby");
    assert.equal(name, "lobby");
    assert.deepEqual(context.params, {});
    client.close();
  });

  test("params are decoded and every segment has to match", async () => {
    const { client, name, context } = await open("/files/my%20docs/a.txt");
    assert.equal(name, "file");
    assert.deepEqual(context.params, { folder: "my docs", name: "a.txt" });
    client.close();

    for (const path of [
      "/rooms/",
      "/rooms/42/extra",
      "/Rooms/42",
      "/files/only-one",
      // not valid percent-encoding, so it can't be decoded
      "/rooms/%E0%A4%A",
    ]) {
      assert.equal((await handshake(port, path)).status, 404, path);
    }
  });

  test("/ matches only the root path", async () => {
    const { client, name } = await open("/");
    assert.equal(name, "root");
    client.close();
  });

  test("connect still fires for a routed connection, before the handler", async () => {
    const connects = connected.length;
    const handlers = routed.length;
    const { client, connection } = await open("/rooms/7");
    assert.equal(connected.length, connects + 1);
    assert.deepEqual(connected.at(-1), { connection, handlers });
    client.close();
  });

  test("the router starts reading, so the handler only adds listeners", async () => {
    const { client, connection } = await open("/rooms/8");
    connection.on("message", (message) =>
      connection.send("text", `room 8: ${message.payload}`),
    );
    const reply = nextText(client);
    client.send("text", "hi");
    assert.equal(await reply, "room 8: hi");
    client.close();
  });

  test("route() needs a pattern that starts with /", () => {
    const router = new WebSocketRouter(new WebSocketServer(createServer()));
    assert.throws(() => router.route("rooms/:id", () => {}), /start with \//);
  });
});

describe("WebSocketRouter with a request listener for auth", () => {
  test("a request the app rejected first never reaches the router", async () => {
    const httpServer = createServer();
    const wsServer = new WebSocketServer(httpServer);
    // added before the router, so it runs first
    wsServer.on("request", (request) => {
      if (request.query.get("token") !== "secret") request.reject(401);
    });
    let handled = 0;
    new WebSocketRouter(wsServer).route("/chat", () => handled++);
    const port = await listen(httpServer);

    const answer = await handshake(port, "/chat?token=wrong");
    assert.equal(answer.status, 401);
    assert.equal(handled, 0);

    const client = await connect(`ws://127.0.0.1:${port}/chat?token=secret`);
    assert.equal(handled, 1);
    client.close();
    httpServer.close();
  });
});

describe("MessageRouter", () => {
  let httpServer: Server;
  let url: string;
  // what the server's handlers received, as [handler, type, data]
  const received: [string, string, unknown][] = [];
  // set by a test to watch the next server connection
  let onConnection: ((connection: WebSocketConnection) => void) | undefined;

  before(async () => {
    httpServer = createServer();
    const wsServer = new WebSocketServer(httpServer);
    const router = new WebSocketRouter(wsServer);

    // a room where "join" and "say" have handlers and the rest goes to the fallback
    router.route("/rooms/:id", (connection, { params }) => {
      onConnection?.(connection);
      const messages = new MessageRouter(connection);
      messages
        .on("join", (data) => {
          received.push(["join", "join", data]);
          // send() answers with a { type, data } message
          messages.send("joined", { room: params["id"], who: data });
        })
        .on("say", (data, type) => received.push(["say", type, data]))
        .fallback((data, type) => received.push(["fallback", type, data]));
    });

    // no fallback: unknown types are ignored
    router.route("/quiet", (connection) => {
      onConnection?.(connection);
      new MessageRouter(connection).on("ping", () =>
        connection.send("text", JSON.stringify({ type: "pong" })),
      );
    });

    url = `ws://127.0.0.1:${await listen(httpServer)}`;
  });

  after(() => {
    httpServer.close();
  });

  function send(client: WebSocketConnection, type: string, data?: unknown) {
    client.send("text", JSON.stringify({ type, data }));
  }

  test("each type reaches its handler with its data", async () => {
    received.length = 0;
    const client = await connect(`${url}/rooms/42`);
    const reply = nextText(client);
    send(client, "join", "Ada");
    assert.deepEqual(JSON.parse(await reply), {
      type: "joined",
      data: { room: "42", who: "Ada" },
    });

    send(client, "say", { text: "hello" });
    // "join" answers, so once its answer is back the server has handled
    // everything sent before it
    const joined = nextText(client);
    send(client, "join", "Bob");
    await joined;

    assert.deepEqual(received, [
      ["join", "join", "Ada"],
      ["say", "say", { text: "hello" }],
      ["join", "join", "Bob"],
    ]);
    client.close();
  });

  test("an unknown type goes to the fallback", async () => {
    received.length = 0;
    const client = await connect(`${url}/rooms/1`);
    send(client, "dance", [1, 2]);
    send(client, "constructor");
    const reply = nextText(client);
    send(client, "join", "Ada");
    await reply;

    assert.deepEqual(received, [
      ["fallback", "dance", [1, 2]],
      ["fallback", "constructor", undefined],
      ["join", "join", "Ada"],
    ]);
    client.close();
  });

  test("without a fallback an unknown type is ignored and the connection stays open", async () => {
    const client = await connect(`${url}/quiet`);
    send(client, "dance");
    const reply = nextText(client);
    send(client, "ping");
    assert.deepEqual(JSON.parse(await reply), { type: "pong" });
    assert.equal(client.readyState, "open");
    client.close();
  });

  for (const [label, text] of [
    ["text that isn't JSON", "hello"],
    ["JSON that isn't an object", "[1,2]"],
    ["JSON null", "null"],
    ["an object without a type", '{"data":1}'],
    ["a type that isn't a string", '{"type":7}'],
  ] as const) {
    test(`${label} closes the connection with 1007`, async () => {
      received.length = 0;
      const client = await connect(`${url}/rooms/1`);
      const closed = once(client, "close");
      client.send("text", text);
      const [code] = await closed;
      assert.equal(code, 1007);
      assert.deepEqual(received, []);
    });
  }

  test("binary messages aren't routed and still arrive as binaryMessage", async () => {
    received.length = 0;
    const serverSide = new Promise<WebSocketConnection>((resolve) => {
      onConnection = resolve;
    });
    const client = await connect(`${url}/rooms/1`);
    const connection = await serverSide;
    onConnection = undefined;

    const binary = once(connection, "binaryMessage");
    client.send("binary", Buffer.from(JSON.stringify({ type: "join" })));
    const [message] = await binary;
    assert.equal(message.type, "binary");
    assert.deepEqual(received, []);
    assert.equal(connection.readyState, "open");
    client.close();
  });
});
