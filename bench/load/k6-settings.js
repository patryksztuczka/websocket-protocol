// Settings shared by the k6 scripts. bench/run.ts passes them as environment
// variables (k6 run -e NAME=value).
import exec from "k6/execution";

export const url = __ENV.URL;
export const connections = Number(__ENV.CONNECTIONS);
export const warmupMs = Number(__ENV.WARMUP_MS);
export const measureMs = Number(__ENV.MEASURE_MS);

/**
 * Where the current moment falls: "warmup" while the JIT warms up, "measure"
 * while results count, "done" after that. Every connection uses the start
 * of the scenario, so they all measure the same window.
 */
export function phase() {
  const elapsed = Date.now() - exec.scenario.startTime;
  if (elapsed < warmupMs) return "warmup";
  if (elapsed < warmupMs + measureMs) return "measure";
  return "done";
}

/**
 * Writes the result to the file bench/run.ts reads, instead of k6's usual
 * summary. `perSecond` names the counter to report as a rate over the
 * measured window.
 */
export function writeResult(data, name, perSecond) {
  const count = (metric) => data.metrics[metric]?.values.count ?? 0;
  const result = {
    [name]: count(perSecond) / (measureMs / 1000),
    errors: count("errors"),
    // connections a fixed-rate scenario never opened because every virtual
    // user was busy; the load was then lighter than asked for
    dropped: count("dropped_iterations"),
  };
  return { [__ENV.RESULT_FILE]: JSON.stringify(result) };
}
