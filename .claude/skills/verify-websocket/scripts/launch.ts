#!/usr/bin/env node
// Starts the verification server in the background on a free port and waits
// until it accepts connections. Prints READY with the address and the run id.
//
//   launch.ts [--run <id>] [--impl ours|ws] [--deflate] [--tls]
//             [--max-message-size <bytes>] [--port <n>]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { isAlive, logCommand, readState, runDir, statePath } from "./common.ts";

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

if (args.impl !== "ours" && args.impl !== "ws") {
  throw new Error(`--impl must be "ours" or "ws", not "${args.impl}"`);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const run = args.run ?? `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
const dir = runDir(run);

if (existsSync(statePath(run))) {
  const state = readState(run);
  if (!state.stoppedAt && isAlive(state.pid)) {
    throw new Error(
      `Run "${run}" already has a server (PID ${state.pid}); pick another --run`,
    );
  }
  throw new Error(
    `Run "${run}" already has evidence in ${dir}; pick another --run`,
  );
}
mkdirSync(dir, { recursive: true });

const log = openSync(path.join(dir, "server.log"), "a");
const appArgs = [
  path.join(import.meta.dirname, "app.ts"),
  "--run",
  run,
  "--impl",
  args.impl,
  "--port",
  args.port,
];
if (args.tls) appArgs.push("--tls");
if (args.deflate) appArgs.push("--deflate");
if (args["max-message-size"])
  appArgs.push("--max-message-size", args["max-message-size"]);

// detached, so the server outlives this command; stop.ts ends it by PID
const child = spawn(process.execPath, appArgs, {
  detached: true,
  stdio: ["ignore", log, log],
});
child.unref();

// ready means the server has listened and recorded its address
const deadline = Date.now() + 10_000;
while (!existsSync(statePath(run))) {
  if (child.exitCode !== null || !isAlive(child.pid ?? -1)) {
    logCommand(run, "launch", 1, "server exited before it listened");
    console.error(
      `Server exited before it listened; see ${path.join(dir, "server.log")}`,
    );
    process.exit(1);
  }
  if (Date.now() > deadline) {
    logCommand(run, "launch", 1, "server did not listen within 10 s");
    console.error(
      `Server did not listen within 10 s; PID ${child.pid}, see server.log`,
    );
    process.exit(1);
  }
  await sleep(50);
}

const state = readState(run);
logCommand(run, "launch", 0, `READY ${state.url} pid=${state.pid}`);
console.log(
  `READY ${state.url} run=${run} pid=${state.pid} impl=${state.impl} deflate=${state.deflate} tls=${state.tls}`,
);
console.log(`Evidence: ${path.relative(process.cwd(), dir) || dir}`);
console.log(`export VERIFY_RUN=${run}`);
