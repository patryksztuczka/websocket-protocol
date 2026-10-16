// Reads the Autobahn report and exits with code 1 if any case failed.
// Run it after `run-wstest.sh`, for example with `pnpm autobahn:check`.
import { readFileSync } from "node:fs";

interface CaseResult {
  behavior: string;
  behaviorClose: string;
}

type Report = Record<string, Record<string, CaseResult>>;

// OK, NON-STRICT, INFORMATIONAL and UNIMPLEMENTED are not failures.
const FAILED = "FAILED";

const reportPath = new URL("./reports/servers/index.json", import.meta.url);

let report: Report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
} catch (error) {
  console.error(`Could not read ${reportPath.pathname}: ${String(error)}`);
  console.error("Run the Autobahn suite first.");
  process.exit(1);
}

// "6.10.2" sorts after "6.9.1".
const compareCaseIds = (a: string, b: string) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const failed: string[] = [];
let total = 0;

for (const [agent, cases] of Object.entries(report)) {
  console.log(`Agent: ${agent}`);

  const sections = new Map<string, Map<string, number>>();
  const caseIds = Object.keys(cases).sort(compareCaseIds);
  total += caseIds.length;

  for (const caseId of caseIds) {
    const { behavior, behaviorClose } = cases[caseId]!;
    const section = caseId.split(".")[0]!;
    const counts = sections.get(section) ?? new Map<string, number>();
    counts.set(behavior, (counts.get(behavior) ?? 0) + 1);
    sections.set(section, counts);

    if (behavior === FAILED || behaviorClose === FAILED) {
      failed.push(
        `  ${caseId}: behavior ${behavior}, behaviorClose ${behaviorClose}`,
      );
    }
  }

  for (const [section, counts] of sections) {
    const sum = [...counts.values()].reduce((a, b) => a + b, 0);
    const summary = [...counts]
      .map(([behavior, count]) => `${count} ${behavior}`)
      .join(", ");
    console.log(`  Section ${section}: ${sum} cases (${summary})`);
  }
}

if (total === 0) {
  console.error("The report has no test cases.");
  process.exit(1);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${total} cases failed:`);
  console.error(failed.join("\n"));
  process.exit(1);
}

console.log(`\nAll ${total} cases passed.`);
