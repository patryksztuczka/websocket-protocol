// Finds the programs the benchmark runs at the versions pinned in
// bench/versions.json, so that results from different days compare. ws is
// pinned in package.json instead, like any other package.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Tool = "node" | "bun" | "k6";

/** The pinned versions, without a leading "v". */
export const pinned = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "versions.json"), "utf8"),
) as Record<Tool, string>;

/** A program and the version it reports. */
export interface FoundTool {
  file: string;
  version: string;
}

/** Asks a program for its version, or returns undefined if it can't run. */
function versionOf(file: string) {
  try {
    // node prints v26.5.0, bun 1.4.3 and k6 "k6 v2.3.0 (commit/...)"
    const output = execFileSync(file, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /\d+\.\d+\.\d+/.exec(output)?.[0];
  } catch {
    return undefined;
  }
}

/** The binary mise installed for the pinned version, if it did. */
function installedByMise(tool: Tool) {
  try {
    return execFileSync(
      "mise",
      ["which", tool, `--tool=${tool}@${pinned[tool]}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    // no mise, or it doesn't have that version
    return undefined;
  }
}

/**
 * Finds a tool at its pinned version: the one on PATH (for Node, the one
 * running this script), or else the one mise installed. If neither is the
 * pinned version, returns the one on PATH, and undefined if there's none.
 */
export function findTool(tool: Tool): FoundTool | undefined {
  const onPath = tool === "node" ? process.execPath : tool;
  const pathVersion = versionOf(onPath);
  if (pathVersion === pinned[tool]) {
    return { file: onPath, version: pathVersion };
  }
  const fromMise = installedByMise(tool);
  if (fromMise && versionOf(fromMise) === pinned[tool]) {
    return { file: fromMise, version: pinned[tool] };
  }
  return pathVersion ? { file: onPath, version: pathVersion } : undefined;
}
