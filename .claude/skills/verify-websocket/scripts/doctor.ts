#!/usr/bin/env node
// Answers "is this instance worth driving?" for a launched run. Read-only,
// apart from one opening handshake on /echo (or / for impl ws). Exits 1 if
// any check fails.
//
//   doctor.ts --run <id>
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  fixtureCert,
  isAlive,
  logCommand,
  readState,
  repoRoot,
  requireRun,
} from "./common.ts";

const { values: args } = parseArgs({ options: { run: { type: "string" } } });
const run = requireRun(args.run);
const state = readState(run);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) =>
  results.push({ check: name, ok, detail });

check(
  "not stopped",
  !state.stoppedAt,
  state.stoppedAt ? `stopped at ${state.stoppedAt}` : "running per server.json",
);

const alive = isAlive(state.pid);
check("process alive", alive, `PID ${state.pid}`);

if (alive) {
  const command = execFileSync(
    "ps",
    ["-o", "command=", "-p", String(state.pid)],
    { encoding: "utf8" },
  ).trim();
  check(
    "process is this run's app",
    command.includes("app.ts") && command.includes(run),
    command,
  );

  let owner = "";
  try {
    owner = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${state.port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    owner = "";
  }
  check(
    "port owned by this process",
    owner.split("\n").includes(String(state.pid)),
    `port ${state.port} listened on by PID ${owner || "nobody"}`,
  );

  const key = randomBytes(16).toString("base64");
  const probePath = state.impl === "ours" ? "/echo" : "/";
  const answer = await new Promise<{
    status: number;
    accept: string | undefined;
  }>((resolve) => {
    const options = {
      host: "127.0.0.1",
      port: state.port,
      path: probePath,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
      ...(state.tls
        ? { ca: readFileSync(fixtureCert), servername: "localhost" }
        : {}),
    };
    const req = (state.tls ? httpsRequest : httpRequest)(options);
    req.on("upgrade", (res, socket) => {
      resolve({
        status: res.statusCode ?? 0,
        accept: res.headers["sec-websocket-accept"],
      });
      socket.destroy();
    });
    req.on("response", (res) => {
      resolve({ status: res.statusCode ?? 0, accept: undefined });
      res.resume();
    });
    req.on("error", (error) => resolve({ status: 0, accept: error.message }));
    req.setTimeout(3000, () => req.destroy(new Error("no answer within 3 s")));
    req.end();
  });
  const expected = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  check(
    `handshake on ${probePath} answers 101`,
    answer.status === 101 && answer.accept === expected,
    `status ${answer.status}${answer.status === 101 ? `, Sec-WebSocket-Accept ${answer.accept === expected ? "valid" : "wrong"}` : ` ${answer.accept ?? ""}`}`,
  );
}

// Node loaded lib/ when the server started; edits after that aren't running
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const libDir = path.join(repoRoot, "lib");
const startedAt = Date.parse(state.startedAt);
const changed = readdirSync(libDir).filter(
  (file) => statSync(path.join(libDir, file)).mtimeMs > startedAt,
);
check(
  "server runs the current code",
  head === state.revision && changed.length === 0,
  `launched at ${state.revision}${state.dirty ? " with uncommitted lib/ changes" : ""}, HEAD is ${head}` +
    (changed.length ? `; changed since launch: ${changed.join(", ")}` : ""),
);

for (const r of results)
  console.log(`${r.ok ? "OK  " : "FAIL"} ${r.check}: ${r.detail}`);
console.log(
  `impl=${state.impl} url=${state.url} deflate=${state.deflate} tls=${state.tls} maxMessageSize=${state.maxMessageSize ?? "default"}`,
);
const failed = results.filter((r) => !r.ok);
logCommand(
  run,
  "doctor",
  failed.length ? 1 : 0,
  failed.length ? `FAIL ${failed.map((r) => r.check).join(", ")}` : "OK",
);
process.exitCode = failed.length ? 1 : 0;
