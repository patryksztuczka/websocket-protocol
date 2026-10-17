// Shared by the verification helpers: where a run keeps its evidence, the
// state file of the server it launched, and the command log.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The repository root; the helpers live in .claude/skills/verify-websocket/scripts. */
export const repoRoot = path.resolve(import.meta.dirname, "../../../..");

/** Every run keeps its evidence in verify-artifacts/<run>/, which cleanup never deletes. */
export const artifactsRoot = path.join(repoRoot, "verify-artifacts");

export function runDir(run: string) {
  return path.join(artifactsRoot, run);
}

/** What launch.ts records about the server it started. */
export interface ServerState {
  run: string;
  pid: number;
  impl: "ours" | "ws";
  port: number;
  /** ws:// or wss:// base address, without a path. */
  url: string;
  tls: boolean;
  deflate: boolean;
  maxMessageSize: number | null;
  /** git HEAD when the server started. */
  revision: string;
  /** Whether lib/ had uncommitted changes when the server started. */
  dirty: boolean;
  startedAt: string;
  stoppedAt?: string;
}

export function statePath(run: string) {
  return path.join(runDir(run), "server.json");
}

export function readState(run: string): ServerState {
  const file = statePath(run);
  if (!existsSync(file)) {
    throw new Error(
      `No server was launched for run "${run}" (${file} is missing)`,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as ServerState;
}

/** The run from --run, or from VERIFY_RUN. */
export function requireRun(run: string | undefined) {
  const value = run ?? process.env["VERIFY_RUN"];
  if (!value) throw new Error("Pass --run <id> or set VERIFY_RUN");
  return value;
}

/** Whether a process with this PID exists. */
export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Appends the command and its outcome to <run>/commands.jsonl, so the
 * evidence shows which actions produced it.
 */
export function logCommand(
  run: string,
  script: string,
  exitCode: number,
  summary: string,
) {
  mkdirSync(runDir(run), { recursive: true });
  appendFileSync(
    path.join(runDir(run), "commands.jsonl"),
    JSON.stringify({
      t: new Date().toISOString(),
      script,
      argv: process.argv.slice(2),
      exitCode,
      summary,
    }) + "\n",
  );
}

/** The self-signed certificate the test suite uses, valid for localhost. */
export const fixtureCert = path.join(
  repoRoot,
  "test/fixtures/localhost-cert.pem",
);
export const fixtureKey = path.join(
  repoRoot,
  "test/fixtures/localhost-key.pem",
);
