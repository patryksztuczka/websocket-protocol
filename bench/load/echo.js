// Throughput: every connection keeps WINDOW text messages of SIZE bytes in
// flight and sends a new one for each echo. Reports echoes per second.
import { WebSocket } from "k6/websockets";
import { Counter } from "k6/metrics";

import {
  connections,
  measureMs,
  phase,
  url,
  warmupMs,
  writeResult,
} from "./k6-settings.js";

const windowSize = Number(__ENV.WINDOW);
const payload = "x".repeat(Number(__ENV.SIZE));

const echoes = new Counter("echoes");
const errors = new Counter("errors");

export const options = {
  scenarios: {
    echo: {
      // one long-lived connection per virtual user
      executor: "per-vu-iterations",
      vus: connections,
      iterations: 1,
      maxDuration: `${Math.ceil((warmupMs + measureMs) / 1000) + 30}s`,
    },
  },
};

export default function () {
  const ws = new WebSocket(url);
  let closing = false;

  ws.onopen = () => {
    for (let i = 0; i < windowSize; i++) ws.send(payload);
  };
  ws.onmessage = () => {
    if (closing) return;
    const now = phase();
    if (now === "done") {
      closing = true;
      ws.close();
      return;
    }
    if (now === "measure") echoes.add(1);
    ws.send(payload);
  };
  ws.onerror = () => errors.add(1);
}

export function handleSummary(data) {
  return writeResult(data, "echoes/s", "echoes");
}
