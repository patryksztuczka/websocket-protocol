// Round-trip time at a fixed, moderate rate: CONNECTIONS connections each send
// RATE text messages of SIZE bytes per second. Uses Node's built-in WebSocket
// client rather than k6, whose clock only counts whole milliseconds, while a
// round trip over loopback takes a fraction of one.
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const env = (name: string) => Number(process.env[name]);
const url = process.env["URL"] ?? "";
const connections = env("CONNECTIONS");
const rate = env("RATE");
const payload = "x".repeat(env("SIZE"));
const warmupMs = env("WARMUP_MS");
const measureMs = env("MEASURE_MS");

let errors = 0;

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
  });
}

const sockets = await Promise.all(Array.from({ length: connections }, open));

const start = performance.now();
const measureFrom = start + warmupMs;
const measureTo = measureFrom + measureMs;
const roundTrips: number[] = [];
const timers: NodeJS.Timeout[] = [];
const interval = 1000 / rate;

sockets.forEach((socket, i) => {
  socket.onerror = () => errors++;
  // echoes come back in the order the messages were sent
  const sentAt: number[] = [];
  socket.onmessage = () => {
    const now = performance.now();
    const sent = sentAt.shift() ?? now;
    if (sent >= measureFrom && sent < measureTo) roundTrips.push(now - sent);
  };
  // spread the connections over the interval, so they don't all send at once
  const offset = setTimeout(
    () => {
      timers.push(
        setInterval(() => {
          sentAt.push(performance.now());
          socket.send(payload);
        }, interval),
      );
    },
    (interval * i) / connections,
  );
  timers.push(offset);
});

// wait out the window, then give the last echoes a moment to arrive
await sleep(warmupMs + measureMs);
for (const timer of timers) clearInterval(timer);
await sleep(500);

if (roundTrips.length === 0) {
  // without samples every percentile would read 0 ms
  throw new Error("No echoes came back during the measured window");
}

roundTrips.sort((a, b) => a - b);
const percentile = (p: number) =>
  roundTrips[
    Math.min(roundTrips.length - 1, Math.floor(roundTrips.length * p))
  ] ?? 0;

const result = {
  "p50 ms": percentile(0.5),
  "p99 ms": percentile(0.99),
  "max ms": roundTrips.at(-1) ?? 0,
  // the rate the timers actually reached, which may fall short of the target
  "messages/s": roundTrips.length / (measureMs / 1000),
  errors,
};
writeFileSync(process.env["RESULT_FILE"] ?? "", JSON.stringify(result));

for (const socket of sockets) socket.close();
