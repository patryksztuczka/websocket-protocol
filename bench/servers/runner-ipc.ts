// The link between a benchmark server and bench/run.ts, which starts the
// server as a child process with an IPC channel.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The messages a benchmark server sends to the runner. */
export type ServerMessage =
  | { type: "listening"; port: number }
  | { type: "stats"; cpuMicros: number; maxRssBytes: number };

/**
 * Tells the runner which port the server got, then answers each "stats"
 * request with the CPU time and the peak memory the process has used so far.
 */
export function reportToRunner(httpServer: Server) {
  const send = (message: ServerMessage) => process.send?.(message);

  process.on("message", (request) => {
    if (request !== "stats") return;
    const cpu = process.cpuUsage();
    send({
      type: "stats",
      cpuMicros: cpu.user + cpu.system,
      // maxRSS is in kilobytes
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    });
  });

  const { port } = httpServer.address() as AddressInfo;
  send({ type: "listening", port });
}
