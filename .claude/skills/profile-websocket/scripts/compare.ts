#!/usr/bin/env node
// Compares the library in the working tree with the library at a git ref,
// under the same benchmark load, and says per metric whether the change made
// it better, worse or no clear difference. Runs bench/run.ts with the
// servers ours@<base> and ours, alternating them, and keeps the results in
// bench/results/compare/<id>/.
//
//   compare.ts --base master [--cases echo-16b,echo-1kib,echo-64kib]
//              [--runs 5] [--seconds 10] [--warmup 3] [--min-change 2]
//              [--id <id>]
//   compare.ts --from bench/results/compare/<id>/bench.json [--min-change 2]
//              (judges results saved by an earlier run again, without running)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    base: { type: "string" },
    cases: { type: "string", default: "echo-16b,echo-1kib,echo-64kib" },
    runs: { type: "string", default: "5" },
    seconds: { type: "string", default: "10" },
    warmup: { type: "string", default: "3" },
    id: { type: "string" },
    "min-change": { type: "string", default: "2" },
    from: { type: "string" },
  },
});

if (!args.base && !args.from) {
  throw new Error("Pass --base <git ref>, e.g. --base master");
}
const head = "ours";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const out = args.from
  ? path.resolve(args.from)
  : path.join(
      repoRoot,
      "bench/results/compare",
      args.id ??
        `${stamp}-vs-${(args.base as string).replace(/[^\w.-]/g, "_")}`,
      "bench.json",
    );
const dir = path.dirname(out);

if (!args.from) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "bench/run.ts"),
      `--servers=ours@${args.base},${head}`,
      `--cases=${args.cases}`,
      `--runs=${args.runs}`,
      `--seconds=${args.seconds}`,
      `--warmup=${args.warmup}`,
      `--out=${out}`,
    ],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
  );
}

interface RunResult {
  metrics: Record<string, number>;
  serverCpu: number;
  serverMaxRssBytes: number;
  serverGcPauseMs: number;
}
const results = JSON.parse(readFileSync(out, "utf8")) as {
  settings: { runs: number; measureMs: number; warmupMs: number };
  servers: Record<string, string>;
  cases: Record<string, { title: string; runs: Record<string, RunResult[]> }>;
};

const base = Object.keys(results.servers).find((name) =>
  name.startsWith("ours@"),
);
if (!base || !(head in results.servers)) {
  throw new Error(`${out} has no ours@<ref> and ours servers to compare`);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

const minChange = Number(args["min-change"]) / 100;
if (!args.from && Number(args.runs) < 5) {
  console.error(
    "With fewer than 5 runs, identical code is called better or worse by chance too often.",
  );
}

/**
 * Better or worse only when every run of one side beats every run of the
 * other and the medians differ by at least --min-change. Overlapping runs
 * are no clear difference, whatever the medians say; so is a difference too
 * small to matter, such as peak memory that is steady to the megabyte.
 */
function verdict(
  baseValues: number[],
  headValues: number[],
  higherIsBetter: boolean,
) {
  const [bMin, bMax] = [Math.min(...baseValues), Math.max(...baseValues)];
  const [hMin, hMax] = [Math.min(...headValues), Math.max(...headValues)];
  const separate = hMin > bMax || hMax < bMin;
  if (!separate) return "no clear difference";
  // from a base of 0 (no GC pause at all), any separate change is big enough
  const baseMedian = median(baseValues);
  const change =
    baseMedian === 0 ? Infinity : Math.abs(median(headValues) / baseMedian - 1);
  if (change < minChange) {
    return `no clear difference (consistent, under ${args["min-change"]}%)`;
  }
  const headAhead = higherIsBetter ? hMin > bMax : hMax < bMin;
  return headAhead ? "better" : "worse";
}

const format = (name: string, value: number) =>
  name.endsWith(" ms")
    ? value.toFixed(2)
    : name === "peak memory"
      ? `${(value / 2 ** 20).toFixed(0)} MiB`
      : name === "GC pause"
        ? `${value.toFixed(0)} ms`
        : Math.round(value).toLocaleString("en-US");

const lines = [
  `Base ${base} (${results.servers[base]}) against head ${head} (${results.servers[head]}),`,
  `${results.settings.runs} runs each, ${results.settings.measureMs / 1000} s after ${results.settings.warmupMs / 1000} s of warm-up, alternating.`,
  "",
  "| Case | Metric | Base median | Head median | Change | Base runs | Head runs | Verdict |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];
const warnings: string[] = [];

for (const [caseName, entry] of Object.entries(results.cases)) {
  const baseRuns = entry.runs[base] ?? [];
  const headRuns = entry.runs[head] ?? [];
  const names = Object.keys(baseRuns[0]?.metrics ?? {}).filter(
    (name) => name !== "errors" && name !== "dropped",
  );
  // a case with any of these doesn't count, so it gets no verdict
  const problems: string[] = [];
  for (const [server, runs] of [
    [base, baseRuns],
    [head, headRuns],
  ] as const) {
    if (runs.some((r) => r.metrics["errors"] || r.metrics["dropped"])) {
      problems.push(
        `${caseName}: ${server} had connection errors or dropped connections; its numbers don't count.`,
      );
    }
    const cpu = median(runs.map((r) => r.serverCpu));
    if (caseName.startsWith("echo") && cpu < 0.85) {
      problems.push(
        `${caseName}: ${server} used only ${Math.round(cpu * 100)}% CPU, so k6 may have been the limit, not the server.`,
      );
    }
  }
  warnings.push(...problems);

  const series: [string, (r: RunResult) => number, boolean][] = [
    ...names.map((name): [string, (r: RunResult) => number, boolean] => [
      name,
      (r) => r.metrics[name] ?? 0,
      // rates are better higher, times better lower
      name.endsWith("/s"),
    ]),
    ["peak memory", (r) => r.serverMaxRssBytes, false],
    ["GC pause", (r) => r.serverGcPauseMs, false],
  ];
  for (const [name, pick, higherIsBetter] of series) {
    const b = baseRuns.map(pick);
    const h = headRuns.map(pick);
    const baseMedian = median(b);
    const change = (median(h) - baseMedian) / baseMedian;
    // a percentage of a base of 0 has no meaning
    const changeText =
      baseMedian === 0
        ? "n/a"
        : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
    const verdictText = problems.length
      ? "not counted (see warnings)"
      : verdict(b, h, higherIsBetter);
    lines.push(
      `| ${caseName} | ${name} | ${format(name, baseMedian)} | ${format(name, median(h))} | ${changeText} | ${b.map((v) => format(name, v)).join(" / ")} | ${h.map((v) => format(name, v)).join(" / ")} | ${verdictText} |`,
    );
  }
}

if (warnings.length)
  lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
const report = lines.join("\n");
writeFileSync(path.join(dir, "compare.md"), report + "\n");
console.log(report);
console.log(`\nResults: ${path.relative(process.cwd(), dir)}`);
