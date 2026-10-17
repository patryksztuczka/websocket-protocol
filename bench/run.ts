// Runs the benchmarks: starts each echo server in bench/servers, puts load on
// it with a script from bench/load and prints the median of several runs as a
// Markdown table. Every run gets a fresh server process. The full results go
// to bench/results/. See "Benchmarks" in the README.
//
// A server named ours@<git ref> runs this library as it was at that ref, with
// today's echo server and harness, so two versions can be compared in one
// run. A name ending in :bun, such as ours:bun, runs that server on Bun
// instead of Node, and the server named bun is Bun's own, Bun.serve.
// --profile cpu or heap profiles each server over the measured window and
// writes the profiles to --profile-dir.
//
// Node, Bun and k6 must be at the versions in bench/versions.json and ws at
// the one in package.json, so results from different days compare; tools.ts
// finds the programs on PATH or in mise. --any-versions runs on whatever is
// installed.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type { ServerMessage } from "./servers/runner-ipc.ts";
import { findTool, pinned, type FoundTool, type Tool } from "./tools.ts";

/** One load scenario. */
interface BenchCase {
  /** What the case measures, shown in the table. */
  title: string;
  /** "k6" runs a k6 script, "node" a TypeScript one. */
  tool: "k6" | "node";
  script: string;
  env: Record<string, number>;
}

const CASES: Record<string, BenchCase> = {
  "echo-16b": {
    title: "Echo, 16 B text, 50 connections",
    tool: "k6",
    script: "echo.js",
    env: { CONNECTIONS: 50, WINDOW: 10, SIZE: 16 },
  },
  "echo-1kib": {
    title: "Echo, 1 KiB text, 50 connections",
    tool: "k6",
    script: "echo.js",
    env: { CONNECTIONS: 50, WINDOW: 10, SIZE: 1024 },
  },
  "echo-64kib": {
    title: "Echo, 64 KiB text, 50 connections",
    tool: "k6",
    script: "echo.js",
    env: { CONNECTIONS: 50, WINDOW: 4, SIZE: 65536 },
  },
  connect: {
    title: "Open and close 300 connections/s",
    tool: "k6",
    script: "connect.js",
    env: { RATE: 300 },
  },
  latency: {
    title: "Round trip at 10,000 msg/s, 16 B",
    tool: "node",
    script: "latency.ts",
    env: { CONNECTIONS: 50, RATE: 200, SIZE: 16 },
  },
};

const SERVERS = ["ours", "ws"];

type Runtime = "node" | "bun";

/**
 * Splits a server name into the code it runs and the runtime it runs on:
 * ours@master:bun is ours@master on Bun. A git ref can't contain ":".
 */
function parseServer(name: string): { code: string; runtime: Runtime } {
  if (name === "bun") return { code: "bun", runtime: "bun" };
  const [code = "", runtime = "node", ...rest] = name.split(":");
  if (rest.length > 0 || (runtime !== "node" && runtime !== "bun")) {
    throw new Error(`Unknown runtime in server ${name}; only :bun is known`);
  }
  return { code, runtime };
}

const { values: args } = parseArgs({
  options: {
    servers: { type: "string", default: SERVERS.join(",") },
    cases: { type: "string", default: Object.keys(CASES).join(",") },
    runs: { type: "string", default: "3" },
    seconds: { type: "string", default: "10" },
    warmup: { type: "string", default: "3" },
    profile: { type: "string" },
    "profile-dir": { type: "string" },
    out: { type: "string" },
    "any-versions": { type: "boolean", default: false },
  },
});

const servers = args.servers.split(",");
const caseNames = args.cases.split(",");
const runs = Number(args.runs);
const measureMs = Number(args.seconds) * 1000;
const warmupMs = Number(args.warmup) * 1000;

if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`--runs must be a whole number of at least 1: ${args.runs}`);
}
if (!(measureMs > 0)) {
  throw new Error(`--seconds must be more than 0: ${args.seconds}`);
}
if (!(warmupMs >= 0)) {
  throw new Error(`--warmup must be 0 or more: ${args.warmup}`);
}
const profile = args.profile;
if (profile !== undefined && profile !== "cpu" && profile !== "heap") {
  throw new Error(`--profile must be "cpu" or "heap": ${profile}`);
}
const profileDir = path.resolve(
  args["profile-dir"] ?? "bench/results/profiles",
);

const repoRoot = path.resolve(import.meta.dirname, "..");
const git = (...gitArgs: string[]) =>
  execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).trim();

for (const name of caseNames) {
  if (!(name in CASES)) throw new Error(`Unknown case: ${name}`);
}
const onBun = servers.some((name) => parseServer(name).runtime === "bun");
if (onBun && profile) {
  // Bun's inspector has no heap profiler and returns empty CPU profiles
  throw new Error("--profile works only with servers that run on Node");
}

const TOOL_NAMES: Record<Tool, string> = { node: "Node", bun: "Bun", k6: "k6" };
// Node runs the servers or the latency client in every benchmark
const needed: Tool[] = ["node"];
if (onBun) needed.push("bun");
if (caseNames.some((name) => CASES[name]?.tool === "k6")) needed.push("k6");

const tools: Partial<Record<Tool, FoundTool>> = {};
/** What isn't at its pinned version, one line each. */
const unpinned: string[] = [];
const toInstall: string[] = [];
for (const tool of needed) {
  const found = findTool(tool);
  if (found) tools[tool] = found;
  if (found?.version === pinned[tool]) continue;
  unpinned.push(
    `${TOOL_NAMES[tool]} ${found ? found.version : "is not installed"}, pinned ${pinned[tool]}`,
  );
  toInstall.push(`${tool}@${pinned[tool]}`);
}

let wsVersion: string | undefined;
if (servers.some((name) => parseServer(name).code === "ws")) {
  const { devDependencies } = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as { devDependencies: Record<string, string> };
  const wsPinned = devDependencies["ws"];
  try {
    const pkg = JSON.parse(
      await readFile(
        path.join(repoRoot, "node_modules/ws/package.json"),
        "utf8",
      ),
    ) as { version: string };
    wsVersion = pkg.version;
  } catch {
    // reported below as not installed
  }
  if (wsVersion !== wsPinned) {
    unpinned.push(
      `ws ${wsVersion ?? "is not installed"}, package.json pins ${wsPinned}; run pnpm install`,
    );
  }
}

if (unpinned.length > 0) {
  const missing = needed.some((tool) => !tools[tool]) || !wsVersion;
  const report = [
    "Not at the pinned versions:",
    ...unpinned.map((line) => `  ${line}`),
    ...(toInstall.length > 0
      ? [
          `Install the pinned versions with: mise install ${toInstall.join(" ")}`,
          "(https://mise.jdx.dev); the benchmark finds them there.",
        ]
      : []),
  ];
  if (!args["any-versions"] || missing) {
    if (!missing) {
      report.push(
        "Or run with --any-versions for a quick check, whose numbers don't compare with the README.",
      );
    }
    console.error(report.join("\n"));
    process.exit(1);
  }
  console.error(`${report.join("\n")}\nRunning anyway (--any-versions).\n`);
}
const node = tools.node as FoundTool;

/** The commit of each ours@<ref>, whose lib/ prepareServers() extracts. */
const commits: Record<string, string> = {};
/** Which code each server runs, and on what, for the results file. */
const revisions: Record<string, string> = {};
for (const name of servers) {
  const { code, runtime } = parseServer(name);
  if (code.startsWith("ours@")) {
    const ref = code.slice("ours@".length);
    try {
      commits[code] = git("rev-parse", "--short", `${ref}^{commit}`);
    } catch {
      throw new Error(`Unknown git ref in server ${name}`);
    }
    revisions[name] = commits[code];
  } else if (code === "ours") {
    const dirty = git("status", "--porcelain", "--", "lib").length > 0;
    revisions[name] =
      git("rev-parse", "--short", "HEAD") +
      (dirty ? " with uncommitted lib/ changes" : "");
  } else if (code === "bun") {
    revisions[name] = "Bun.serve";
  } else if (code === "ws") {
    revisions[name] = `ws ${wsVersion}`;
  } else {
    throw new Error(`Unknown server: ${name}`);
  }
  if (runtime === "bun") revisions[name] += ` on Bun ${tools.bun?.version}`;
}

const benchDir = import.meta.dirname;

/** The script each server runs; filled in by prepareServers(). */
const serverFiles: Record<string, string> = {};

/**
 * Finds each server's script. For ours@<ref> it extracts lib/ at that ref
 * next to a copy of today's echo server, so only the library differs.
 */
async function prepareServers(tmp: string) {
  const extracted = new Set<string>();
  for (const name of servers) {
    const { code } = parseServer(name);
    if (!code.startsWith("ours@")) {
      serverFiles[name] = path.join(benchDir, "servers", `${code}.ts`);
      continue;
    }
    const commit = commits[code] as string;
    const dir = path.join(tmp, `ref-${commit}`);
    serverFiles[name] = path.join(dir, "bench/servers/ours.ts");
    // ours@<ref> and ours@<ref>:bun share one copy
    if (extracted.has(commit)) continue;
    extracted.add(commit);
    await mkdir(path.join(dir, "bench/servers"), { recursive: true });
    const tarball = execFileSync(
      "git",
      ["archive", "--format=tar", commit, "lib"],
      { cwd: repoRoot, maxBuffer: 1 << 28 },
    );
    execFileSync("tar", ["-x", "-C", dir], { input: tarball });
    for (const file of ["ours.ts", "runner-ipc.ts"]) {
      await copyFile(
        path.join(benchDir, "servers", file),
        path.join(dir, "bench/servers", file),
      );
    }
    await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
  }
}

/** Starts a benchmark server and resolves once it listens. */
async function startServer(name: string) {
  const runtime =
    parseServer(name).runtime === "bun" ? (tools.bun as FoundTool) : node;
  const child = spawn(runtime.file, [serverFiles[name] as string], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const message = await nextMessage(child);
  if (message.type !== "listening") throw new Error("Server did not start");
  return { child, url: `ws://127.0.0.1:${message.port}` };
}

function hasExited(child: ChildProcess) {
  // a child killed by a signal keeps exitCode null and sets signalCode
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolves with the next message from a server, or rejects once the server
 * has exited, so a server that crashes fails the run instead of hanging it.
 */
function nextMessage(child: ChildProcess): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const exitError = () =>
      new Error(
        `Server exited with ${child.signalCode ?? `code ${child.exitCode}`}`,
      );
    if (hasExited(child)) {
      reject(exitError());
      return;
    }
    const onExit = () => {
      child.off("message", onMessage);
      reject(exitError());
    };
    const onMessage = (message: unknown) => {
      child.off("exit", onExit);
      resolve(message as ServerMessage);
    };
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}

/** Asks a server for the CPU time and peak memory it has used so far. */
async function serverStats(child: ChildProcess) {
  // sending to a server that has exited would throw ERR_IPC_CHANNEL_CLOSED
  if (!hasExited(child)) child.send("stats");
  const message = await nextMessage(child);
  if (message.type !== "stats") throw new Error("Unexpected server message");
  return message;
}

/** Runs a load script against a server and resolves with what it reported. */
async function runLoad(bench: BenchCase, url: string, resultFile: string) {
  const env = {
    ...bench.env,
    URL: url,
    WARMUP_MS: warmupMs,
    MEASURE_MS: measureMs,
    RESULT_FILE: resultFile,
  };
  const script = path.join(benchDir, "load", bench.script);
  const command =
    bench.tool === "k6"
      ? {
          file: (tools.k6 as FoundTool).file,
          args: [
            "run",
            "--quiet",
            ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
            script,
          ],
          env: process.env,
        }
      : {
          file: node.file,
          args: [script],
          env: { ...process.env, ...stringValues(env) },
        };

  const load = spawn(command.file, command.args, {
    env: command.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const [code] = (await once(load, "exit")) as [number | null];
  if (code !== 0) throw new Error(`${bench.script} exited with code ${code}`);
  return JSON.parse(await readFile(resultFile, "utf8")) as Record<
    string,
    number
  >;
}

function stringValues(env: Record<string, string | number>) {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, String(v)]),
  );
}

interface RunResult {
  metrics: Record<string, number>;
  /** Server CPU time over the run, as a share of one core. */
  serverCpu: number;
  serverMaxRssBytes: number;
  /**
   * Garbage collections in the server during the run, and their pauses.
   * null on Bun, which doesn't report them.
   */
  serverGcCount: number | null;
  serverGcPauseMs: number | null;
  /** The profile written for this run, with --profile. */
  profile?: string;
}

async function runOnce(
  caseName: string,
  bench: BenchCase,
  server: string,
  run: number,
  tmp: string,
): Promise<RunResult> {
  const { child, url } = await startServer(server);
  try {
    const before = await serverStats(child);
    const startedAt = performance.now();

    // the profile starts once the warm-up is over
    const started: { reply?: Promise<ServerMessage> } = {};
    const timer = profile
      ? setTimeout(() => {
          child.send({ type: "profile-start", kind: profile });
          started.reply = nextMessage(child);
          // awaited below; this only keeps an early exit from going unhandled
          started.reply.catch(() => {});
        }, warmupMs)
      : undefined;

    const metrics = await runLoad(bench, url, path.join(tmp, "result.json"));
    const wallMicros = (performance.now() - startedAt) * 1000;
    clearTimeout(timer);

    let profileFile: string | undefined;
    if (profile) {
      if (!started.reply) {
        throw new Error("The load ended before the warm-up");
      }
      await started.reply;
      const safeServer = server.replace(/[^\w.-]/g, "_");
      profileFile = path.join(
        profileDir,
        `${caseName}-${safeServer}-run${run}.${profile === "cpu" ? "cpuprofile" : "heapprofile"}`,
      );
      await mkdir(profileDir, { recursive: true });
      child.send({ type: "profile-stop", file: profileFile });
      const written = await nextMessage(child);
      if (written.type !== "profile-written") {
        throw new Error("Unexpected server message");
      }
    }

    const after = await serverStats(child);
    return {
      metrics,
      serverCpu: (after.cpuMicros - before.cpuMicros) / wallMicros,
      serverMaxRssBytes: after.maxRssBytes,
      serverGcCount: difference(before.gcCount, after.gcCount),
      serverGcPauseMs: difference(before.gcPauseMs, after.gcPauseMs),
      ...(profileFile ? { profile: profileFile } : {}),
    };
  } finally {
    if (!hasExited(child)) {
      child.kill();
      await once(child, "exit");
    }
  }
}

function difference(before: number | null, after: number | null) {
  return before === null || after === null ? null : after - before;
}

/**
 * Counts a load script reports when the load it put on the server was not
 * the one asked for. They are not results, so the table leaves them out.
 */
const PROBLEM_COUNTS = ["errors", "dropped"];

/** Describes the problems of one run, or returns "" if it had none. */
function describeProblems(metrics: Record<string, number>) {
  const errors = metrics["errors"] ?? 0;
  const dropped = metrics["dropped"] ?? 0;
  return [
    errors ? `${errors} connection errors` : "",
    dropped ? `${dropped} connections not opened because k6 was busy` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function median(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function format(name: string, value: number) {
  if (name.endsWith(" ms")) return value.toFixed(2);
  return Math.round(value).toLocaleString("en-US");
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "websocket-bench-"));
const results: Record<string, Record<string, RunResult[]>> = {};
const rows: string[] = [];

try {
  await prepareServers(tmp);
  for (const caseName of caseNames) {
    const bench = CASES[caseName] as BenchCase;
    const byServer: Record<string, RunResult[]> = {};
    results[caseName] = byServer;
    for (let run = 1; run <= runs; run++) {
      // alternate the order, so a machine that slows down over time doesn't
      // always favour the same server
      const order = run % 2 ? servers : servers.toReversed();
      for (const server of order) {
        console.error(`${caseName}: ${server}, run ${run} of ${runs}`);
        const result = await runOnce(caseName, bench, server, run, tmp);
        const problems = describeProblems(result.metrics);
        if (problems) console.error(`  ${problems}`);
        (byServer[server] ??= []).push(result);
      }
    }

    for (const server of servers) {
      const serverRuns = byServer[server] ?? [];
      const names = Object.keys(serverRuns[0]?.metrics ?? {}).filter(
        (name) => !PROBLEM_COUNTS.includes(name),
      );
      const metrics = names
        .map(
          (name) =>
            `${format(name, median(serverRuns.map((r) => r.metrics[name] ?? 0)))} ${name}`,
        )
        .join(", ");
      const cpu = median(serverRuns.map((r) => r.serverCpu));
      const rss = median(serverRuns.map((r) => r.serverMaxRssBytes));
      const flawedRuns = serverRuns.filter((r) =>
        describeProblems(r.metrics),
      ).length;
      const warning = flawedRuns
        ? ` (${flawedRuns} of ${serverRuns.length} runs had connection errors or dropped connections; don't compare)`
        : "";
      rows.push(
        `| ${bench.title} | ${server} | ${metrics}${warning} | ${Math.round(cpu * 100)}% | ${Math.round(rss / 2 ** 20)} MiB |`,
      );
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(
  [
    `Median of ${runs} runs, ${measureMs / 1000} s each after ${warmupMs / 1000} s of warm-up.`,
    "",
    "| Case | Server | Result | Server CPU | Server peak memory |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n"),
);

const resultsFile = args.out
  ? path.resolve(args.out)
  : path.join(
      benchDir,
      "results",
      `${new Date().toISOString().replaceAll(":", "-")}.json`,
    );
await mkdir(path.dirname(resultsFile), { recursive: true });
await writeFile(
  resultsFile,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      machine: {
        cpu: os.cpus()[0]?.model,
        cores: os.availableParallelism(),
        platform: `${os.platform()} ${os.release()}`,
      },
      // what ran, and whether all of it was at the pinned versions
      versions: {
        ...Object.fromEntries(
          Object.entries(tools).map(([tool, found]) => [tool, found.version]),
        ),
        ...(wsVersion ? { ws: wsVersion } : {}),
      },
      pinnedVersions: unpinned.length === 0,
      settings: { runs, measureMs, warmupMs, profile: profile ?? null },
      servers: revisions,
      cases: Object.fromEntries(
        caseNames.map((name) => [
          name,
          { ...CASES[name], runs: results[name] },
        ]),
      ),
    },
    null,
    2,
  ),
);
console.error(`\nFull results: ${path.relative(process.cwd(), resultsFile)}`);
