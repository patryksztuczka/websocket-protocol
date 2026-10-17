#!/usr/bin/env node
// Stops the server a run launched, by the PID in its server.json, after
// checking that the PID still belongs to that run's app. Keeps every file in
// verify-artifacts/<run>/: the evidence outlives the server.
//
//   stop.ts --run <id>
//   stop.ts --all      every run under verify-artifacts/ whose server still runs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  artifactsRoot,
  isAlive,
  logCommand,
  readState,
  requireRun,
  runDir,
  statePath,
} from "./common.ts";

const { values: args } = parseArgs({
  options: {
    run: { type: "string" },
    all: { type: "boolean", default: false },
  },
});

const runs = args.all
  ? existsSync(artifactsRoot)
    ? readdirSync(artifactsRoot).filter((run) => existsSync(statePath(run)))
    : []
  : [requireRun(args.run)];

let failed = false;
let stopped = 0;
for (const run of runs) {
  const state = readState(run);
  if (state.stoppedAt || !isAlive(state.pid)) {
    if (!args.all) console.log(`${run}: not running`);
    continue;
  }
  // a PID can be reused by an unrelated process once ours has exited
  const command = execFileSync(
    "ps",
    ["-o", "command=", "-p", String(state.pid)],
    { encoding: "utf8" },
  ).trim();
  if (!(command.includes("app.ts") && command.includes(run))) {
    console.log(
      `${run}: PID ${state.pid} now belongs to another process (${command}); not touching it`,
    );
    continue;
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (isAlive(state.pid) && Date.now() < deadline) await sleep(50);
  if (isAlive(state.pid)) process.kill(state.pid, "SIGKILL");
  await sleep(50);
  if (isAlive(state.pid)) {
    failed = true;
    console.log(`${run}: PID ${state.pid} is still running`);
    logCommand(run, "stop", 1, `PID ${state.pid} still running`);
    continue;
  }
  writeFileSync(
    statePath(run),
    JSON.stringify({ ...state, stoppedAt: new Date().toISOString() }, null, 2),
  );
  logCommand(run, "stop", 0, `stopped PID ${state.pid}`);
  stopped++;
  console.log(
    `${run}: stopped PID ${state.pid}; evidence kept in ${path.relative(process.cwd(), runDir(run))}`,
  );
}
if (args.all && stopped === 0) console.log("No running servers to stop");
process.exitCode = failed ? 1 : 0;
