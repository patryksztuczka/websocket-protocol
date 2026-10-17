// Opening handshakes: opens RATE connections per second and closes each one
// as soon as it is open. Reports the connections opened per second; compare
// the servers by the CPU time they need for them.
//
// The rate is fixed rather than as fast as possible: every closed connection
// can leave its client port in TIME_WAIT for 30 seconds, and a single machine
// only has about 16,000 of them (28,000 on Linux), so an unlimited run fails
// to connect after a few seconds.
import { WebSocket } from "k6/websockets";
import { Counter } from "k6/metrics";

import { measureMs, phase, url, warmupMs, writeResult } from "./k6-settings.js";

const opened = new Counter("opened");
const errors = new Counter("errors");

export const options = {
  scenarios: {
    connect: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE),
      timeUnit: "1s",
      duration: `${(warmupMs + measureMs) / 1000}s`,
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
};

// the iteration ends once the connection has closed
export default function () {
  const ws = new WebSocket(url);
  ws.onopen = () => {
    if (phase() === "measure") opened.add(1);
    ws.close();
  };
  ws.onerror = () => errors.add(1);
}

export function handleSummary(data) {
  return writeResult(data, "connections/s", "opened");
}
