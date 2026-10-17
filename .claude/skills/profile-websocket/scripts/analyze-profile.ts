#!/usr/bin/env node
// Turns a V8 profile into a text summary an agent can read: where the time
// (.cpuprofile) or the allocated bytes (.heapprofile) went, by area and by
// function, with the file and line of each function.
//
//   analyze-profile.ts <file.cpuprofile|file.heapprofile> [--top 25] [--per <n>]
//
// --per divides totals by n, e.g. the number of messages echoed while the
// profile ran, to print time or bytes per message.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    top: { type: "string", default: "25" },
    per: { type: "string" },
  },
});

const file = positionals[0];
if (!file) throw new Error("Pass a .cpuprofile or .heapprofile file");
const top = Number(args.top);
const per = args.per ? Number(args.per) : null;
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

/** Where a function lives, as a reader would look it up. */
function location(frame: CallFrame) {
  // file URLs percent-encode characters such as spaces
  let url = frame.url.startsWith("file:")
    ? fileURLToPath(frame.url)
    : frame.url;
  // lib/ of an older revision, extracted by bench/run.ts for ours@<ref>
  const ref = url.match(/\/ref-([0-9a-f]+)\/(.*)$/);
  if (ref) url = `${ref[2]} @${ref[1]}`;
  else if (url.startsWith(repoRoot)) url = path.relative(repoRoot, url);
  return url ? `${url}:${frame.lineNumber + 1}` : "";
}

function area(frame: CallFrame) {
  const name = frame.functionName;
  if (name === "(garbage collector)") return "garbage collector";
  if (name === "(idle)") return "idle";
  if (name === "(program)") return "V8 (program)";
  if (name === "(root)") return "root";
  const where = location(frame);
  if (where.startsWith("lib/")) return "lib/ (this library)";
  if (where.includes("node_modules/ws/")) return "ws";
  if (where.startsWith("bench/")) return "bench/ (harness)";
  if (frame.url.startsWith("node:")) return "Node internals";
  return "native / V8 builtins";
}

const keyOf = (frame: CallFrame) =>
  `${frame.functionName || "(anonymous)"}  ${location(frame)}`.trim();

/** A call tree node, the same for both profile kinds. */
interface TreeNode {
  frame: CallFrame;
  self: number;
  children: TreeNode[];
}

function loadTree(): { root: TreeNode; kind: "cpu" | "heap" } {
  const profile = JSON.parse(readFileSync(file as string, "utf8"));
  if (profile.head) {
    // heap: every node has its own sampled bytes
    const convert = (node: {
      callFrame: CallFrame;
      selfSize: number;
      children: unknown[];
    }): TreeNode => ({
      frame: node.callFrame,
      self: node.selfSize,
      children: node.children.map((child) => convert(child as typeof node)),
    });
    return { root: convert(profile.head), kind: "heap" };
  }
  // cpu: a sample lasts until the next one; timeDeltas are in microseconds
  const nodes = new Map<number, TreeNode>();
  for (const node of profile.nodes) {
    nodes.set(node.id, { frame: node.callFrame, self: 0, children: [] });
  }
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      nodes.get(node.id)?.children.push(nodes.get(child) as TreeNode);
    }
  }
  const samples: number[] = profile.samples;
  const deltas: number[] = profile.timeDeltas;
  samples.forEach((id, i) => {
    const node = nodes.get(id);
    if (node) node.self += deltas[i + 1] ?? 0;
  });
  return { root: nodes.get(profile.nodes[0].id) as TreeNode, kind: "cpu" };
}

const { root, kind } = loadTree();

const selfByKey = new Map<string, { value: number; area: string }>();
const totalByKey = new Map<string, number>();
const byArea = new Map<string, number>();

/** Adds up a subtree; a function that recurses is counted once in its total. */
function walk(node: TreeNode, onStack: Set<string>): number {
  const key = keyOf(node.frame);
  const nodeArea = area(node.frame);
  const entry = selfByKey.get(key) ?? { value: 0, area: nodeArea };
  entry.value += node.self;
  selfByKey.set(key, entry);
  byArea.set(nodeArea, (byArea.get(nodeArea) ?? 0) + node.self);

  const outer = !onStack.has(key);
  if (outer) onStack.add(key);
  let total = node.self;
  for (const child of node.children) total += walk(child, onStack);
  if (outer) {
    onStack.delete(key);
    totalByKey.set(key, (totalByKey.get(key) ?? 0) + total);
  }
  return total;
}
walk(root, new Set());

const idle = byArea.get("idle") ?? 0;
let all = 0;
for (const value of byArea.values()) all += value;
const busy = all - idle;

const amount = (value: number) =>
  kind === "cpu"
    ? `${(value / 1e6).toFixed(3)} s`
    : `${(value / 2 ** 20).toFixed(1)} MiB`;
const perItem = (value: number) =>
  kind === "cpu"
    ? `${(value / (per as number)).toFixed(2)} µs`
    : `${Math.round(value / (per as number)).toLocaleString("en-US")} B`;
const share = (value: number) =>
  `${((value / busy) * 100).toFixed(1).padStart(5)}%`;

const lines: string[] = [];
lines.push(`${kind === "cpu" ? "CPU" : "Allocation"} profile: ${file}`);
if (kind === "cpu") {
  lines.push(
    `Sampled ${amount(all)}: busy ${amount(busy)} (${((busy / all) * 100).toFixed(0)}%), idle ${amount(idle)}`,
  );
} else {
  lines.push(
    `Allocated ${amount(busy)} (sampled estimate, including memory the GC has already freed)`,
  );
}
if (per) {
  lines.push(
    `Per item (${per.toLocaleString("en-US")} items): ${perItem(busy)} ${kind === "cpu" ? "of CPU" : "allocated"}`,
  );
}

lines.push(
  "",
  `By area (share of ${kind === "cpu" ? "busy time" : "allocated bytes"}):`,
);
for (const [name, value] of [...byArea].sort((a, b) => b[1] - a[1])) {
  if (name === "idle" || value === 0) continue;
  lines.push(`  ${share(value)}  ${amount(value).padStart(10)}  ${name}`);
}

lines.push(
  "",
  `Top ${top} functions by self ${kind === "cpu" ? "time" : "allocation"}:`,
);
for (const [key, entry] of [...selfByKey]
  .filter(([, e]) => e.area !== "idle")
  .sort((a, b) => b[1].value - a[1].value)
  .slice(0, top)) {
  lines.push(`  ${share(entry.value)}  ${key}  [${entry.area}]`);
}

lines.push(
  "",
  `Top ${top} functions in lib/ by total ${kind === "cpu" ? "time" : "allocation"} (self and everything they call):`,
);
for (const [key, value] of [...totalByKey]
  .filter(([key]) => selfByKey.get(key)?.area === "lib/ (this library)")
  .sort((a, b) => b[1] - a[1])
  .slice(0, top)) {
  lines.push(
    `  ${share(value)}  ${key}${per ? `  (${perItem(value)} per item)` : ""}`,
  );
}

console.log(lines.join("\n"));
