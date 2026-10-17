// The link between a benchmark server and bench/run.ts, which starts the
// server as a child process with an IPC channel.
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { Session } from "node:inspector/promises";
import type { AddressInfo } from "node:net";
import { PerformanceObserver } from "node:perf_hooks";

/** The messages a benchmark server sends to the runner. */
export type ServerMessage =
  | { type: "listening"; port: number }
  | {
      type: "stats";
      cpuMicros: number;
      maxRssBytes: number;
      /** Garbage collections so far, and the time they paused the thread. */
      gcCount: number;
      gcPauseMs: number;
    }
  | { type: "profile-started" }
  | { type: "profile-written"; file: string };

/** The requests the runner sends to a benchmark server. */
export type RunnerRequest =
  | "stats"
  | { type: "profile-start"; kind: "cpu" | "heap" }
  | { type: "profile-stop"; file: string };

/**
 * Tells the runner which port the server got, then answers its requests:
 * "stats" with the CPU time, peak memory and garbage collection so far, and
 * "profile-start" and "profile-stop" by profiling the process in between,
 * through the inspector, so a profile covers only the measured window.
 */
export function reportToRunner(httpServer: Server) {
  const send = (message: ServerMessage) => process.send?.(message);

  let gcCount = 0;
  let gcPauseMs = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcPauseMs += entry.duration;
    }
  }).observe({ entryTypes: ["gc"] });

  let profiling: { session: Session; kind: "cpu" | "heap" } | null = null;

  process.on("message", async (request: RunnerRequest) => {
    if (request === "stats") {
      const cpu = process.cpuUsage();
      send({
        type: "stats",
        cpuMicros: cpu.user + cpu.system,
        // maxRSS is in kilobytes
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
        gcCount,
        gcPauseMs,
      });
    } else if (request.type === "profile-start") {
      const session = new Session();
      session.connect();
      if (request.kind === "cpu") {
        await session.post("Profiler.enable");
        // every 100 µs rather than the default 1 ms, for short runs
        await session.post("Profiler.setSamplingInterval", { interval: 100 });
        await session.post("Profiler.start");
      } else {
        await session.post("HeapProfiler.enable");
        // count objects the GC has already freed too, so the profile shows
        // where memory is allocated, not only what is still alive
        await session.post("HeapProfiler.startSampling", {
          samplingInterval: 16384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      profiling = { session, kind: request.kind };
      send({ type: "profile-started" });
    } else if (request.type === "profile-stop" && profiling) {
      const { session, kind } = profiling;
      const { profile } =
        kind === "cpu"
          ? await session.post("Profiler.stop")
          : await session.post("HeapProfiler.stopSampling");
      session.disconnect();
      profiling = null;
      writeFileSync(request.file, JSON.stringify(profile));
      send({ type: "profile-written", file: request.file });
    }
  });

  // a runner that was killed can't stop its servers, so they stop themselves
  process.on("disconnect", () => process.exit(0));

  const { port } = httpServer.address() as AddressInfo;
  send({ type: "listening", port });
}
