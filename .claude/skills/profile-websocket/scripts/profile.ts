#!/usr/bin/env node
// Profiles servers under a benchmark load and summarizes where the CPU time
// or the allocated memory went. Runs `bench/run.ts --profile` once per kind,
// then analyze-profile.ts on each profile, and keeps everything in
// bench/results/profiles/<id>/.
//
//   profile.ts --case echo-1kib [--servers ours,ws,ours@master]
//              [--kind cpu|heap|both] [--seconds 10] [--warmup 3]
//              [--id <id>] [--top 25]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    case: { type: "string" },
    servers: { type: "string", default: "ours" },
    kind: { type: "string", default: "both" },
    seconds: { type: "string", default: "10" },
    warmup: { type: "string", default: "3" },
    id: { type: "string" },
    top: { type: "string", default: "25" },
  },
});

if (!args.case) throw new Error("Pass --case, e.g. --case echo-1kib");
if (!["cpu", "heap", "both"].includes(args.kind)) {
  throw new Error(`--kind must be cpu, heap or both: ${args.kind}`);
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const id = args.id ?? `${stamp}-${args.case}`;
const dir = path.join(repoRoot, "bench/results/profiles", id);
const kinds = args.kind === "both" ? ["cpu", "heap"] : [args.kind];

interface BenchResults {
  servers: Record<string, string>;
  cases: Record<
    string,
    {
      runs: Record<
        string,
        {
          metrics: Record<string, number>;
          serverCpu: number;
          profile?: string;
        }[]
      >;
    }
  >;
}

const summaries: string[] = [];
for (const kind of kinds) {
  const out = path.join(dir, `bench-${kind}.json`);
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "bench/run.ts"),
      `--servers=${args.servers}`,
      `--cases=${args.case}`,
      "--runs=1",
      `--seconds=${args.seconds}`,
      `--warmup=${args.warmup}`,
      `--profile=${kind}`,
      `--profile-dir=${dir}`,
      `--out=${out}`,
    ],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
  );

  const results = JSON.parse(readFileSync(out, "utf8")) as BenchResults;
  const runs = results.cases[args.case]?.runs ?? {};
  for (const [server, [run]] of Object.entries(runs)) {
    if (!run?.profile) continue;
    // the rate the load reported, times the measured window, is roughly how
    // many messages or connections the profile covers
    const [rateName, rate] =
      Object.entries(run.metrics).find(([name]) => name.endsWith("/s")) ?? [];
    const items = rate ? Math.round(rate * Number(args.seconds)) : null;
    const summary = execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "analyze-profile.ts"),
        run.profile,
        `--top=${args.top}`,
        ...(items ? [`--per=${items}`] : []),
      ],
      { encoding: "utf8" },
    );
    const header = [
      `== ${kind} profile of ${server} (${results.servers[server]}) on ${args.case}`,
      `Load while profiled: ${rate ? `${Math.round(rate).toLocaleString("en-US")} ${rateName}` : "n/a"}, server CPU ${Math.round(run.serverCpu * 100)}%. Profiling slows the server; don't use these numbers as a benchmark.`,
      items
        ? `Per item means per ${rateName?.replace("/s", "")}, about ${items.toLocaleString("en-US")} of them.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const text = `${header}\n${summary}`;
    const summaryFile = `${run.profile}.txt`;
    writeFileSync(summaryFile, text);
    summaries.push(text);
  }
}

console.log(summaries.join("\n"));
console.log(`Profiles and summaries: ${path.relative(process.cwd(), dir)}`);
