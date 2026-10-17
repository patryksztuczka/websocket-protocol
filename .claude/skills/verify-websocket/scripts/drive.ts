#!/usr/bin/env node
// Connects as a WebSocket client and runs steps in order, the way an app
// would use a connection. Writes a transcript and exits 1 if any step fails.
//
//   drive.ts --run <id> --path /echo [--client builtin|ours] [--deflate]
//            [--name <transcript>] [--timeout <ms>] <step>...
//   drive.ts --url ws://host:port/path --out <dir> ...   (a server this run didn't launch)
//
// Steps:
//   send:<text>            send a text message
//   send-hex:<hex>         send a binary message
//   send-size:<n>          send a text message of n "x" characters
//   expect:<text>          the next message is this text
//   expect-hex:<hex>       the next message is binary with these bytes
//   expect-json:<json>     the next message is text that parses to this JSON
//   expect-size:<n>        the next message is n bytes long
//   close[:<code>[:<reason>]]  start the closing handshake
//   expect-close:<code>    the connection closes with this code
//   wait:<ms>              pause
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { WebSocketClient } from "../../../../lib/web-socket-client.ts";
import type { WebSocketConnection } from "../../../../lib/web-socket-connection.ts";
import {
  fixtureCert,
  logCommand,
  readState,
  requireRun,
  runDir,
} from "./common.ts";

const { values: args, positionals: steps } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: "string" },
    path: { type: "string", default: "/echo" },
    url: { type: "string" },
    out: { type: "string" },
    client: { type: "string", default: "builtin" },
    deflate: { type: "boolean", default: false },
    name: { type: "string" },
    timeout: { type: "string", default: "5000" },
  },
});

const external = args.url !== undefined;
const run = external ? null : requireRun(args.run);
const state = run ? readState(run) : null;
const url = args.url ?? `${state?.url}${args.path}`;
const outDir = args.out ?? (run ? path.join(runDir(run), "transcripts") : null);
if (!outDir) throw new Error("Pass --out <dir> with --url");
const timeoutMs = Number(args.timeout);
const name = args.name ?? `drive-${Date.now()}`;
const transcript = path.join(outDir, `${name}.jsonl`);

// Node's built-in client trusts only the system CAs; restart with the test
// certificate added when the server uses it
if (
  url.startsWith("wss:") &&
  args.client === "builtin" &&
  process.env["NODE_EXTRA_CA_CERTS"] !== fixtureCert
) {
  const again = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: fixtureCert },
  });
  process.exit(again.status ?? 1);
}

mkdirSync(outDir, { recursive: true });
const record = (kind: string, details: Record<string, unknown> = {}) => {
  const line = { t: new Date().toISOString(), kind, ...details };
  appendFileSync(transcript, JSON.stringify(line) + "\n");
  console.log(`${kind} ${JSON.stringify(details)}`);
};

type Incoming =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Buffer };
type Closed = { code: number; reason: string };

/** The same small interface over both clients. */
interface Driver {
  extensions: string;
  sendText(text: string): void;
  sendBinary(bytes: Buffer): void;
  close(code?: number, reason?: string): void;
}

const inbox: Incoming[] = [];
let closed: Closed | null = null;
let wake: (() => void) | null = null;
const notify = () => {
  wake?.();
  wake = null;
};

function onIncoming(message: Incoming) {
  record("recv", describe(message));
  inbox.push(message);
  notify();
}
function onClose(code: number, reason: string) {
  closed = { code, reason };
  record("closed", closed);
  notify();
}

function describe(message: Incoming) {
  return message.kind === "text"
    ? {
        type: "text",
        bytes: Buffer.byteLength(message.text),
        text: message.text.slice(0, 200),
      }
    : {
        type: "binary",
        bytes: message.bytes.length,
        hex: message.bytes.subarray(0, 64).toString("hex"),
      };
}

function connectBuiltin(): Promise<Driver> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () =>
      resolve({
        extensions: socket.extensions,
        sendText: (text) => socket.send(text),
        sendBinary: (bytes) => socket.send(new Uint8Array(bytes)),
        close: (code, reason) => socket.close(code, reason),
      });
    socket.onerror = () =>
      reject(
        new Error(
          "connection failed (the built-in client gives no reason; use raw.ts to see the HTTP answer)",
        ),
      );
    socket.onmessage = (e) =>
      onIncoming(
        typeof e.data === "string"
          ? { kind: "text", text: e.data }
          : { kind: "binary", bytes: Buffer.from(e.data as ArrayBuffer) },
      );
    socket.onclose = (e) => onClose(e.code, e.reason);
  });
}

function connectOurs(): Promise<Driver> {
  return new Promise((resolve, reject) => {
    const client = new WebSocketClient();
    client.on("connect", (connection: WebSocketConnection) => {
      connection.on("message", (m) =>
        onIncoming({ kind: "text", text: m.payload }),
      );
      connection.on("binaryMessage", (m) =>
        onIncoming({ kind: "binary", bytes: m.payload }),
      );
      connection.on("close", onClose);
      resolve({
        extensions: String(
          connection.headers["sec-websocket-extensions"] ?? "",
        ),
        sendText: (text) => connection.send("text", text),
        sendBinary: (bytes) => connection.send("binary", bytes),
        close: (code, reason) => connection.close(code, reason),
      });
    });
    client.on("connectionFailed", (reason: string) =>
      reject(new Error(reason)),
    );
    client.connect(url, {
      perMessageDeflate: args.deflate,
      ...(url.startsWith("wss:")
        ? { tls: { ca: readFileSync(fixtureCert) } }
        : {}),
    });
  });
}

/** Waits until the condition holds, or fails the step after the timeout. */
async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    const left = deadline - Date.now();
    if (left <= 0)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, left);
    });
  }
}

const nextMessage = (what: string) =>
  until(() => inbox.shift() ?? (closed ? null : undefined), what).then((m) => {
    if (m === null)
      throw new Error(`connection closed while waiting for ${what}`);
    return m;
  });

async function runStep(step: string, driver: Driver) {
  const colon = step.indexOf(":");
  const op = colon === -1 ? step : step.slice(0, colon);
  const arg = colon === -1 ? "" : step.slice(colon + 1);
  switch (op) {
    case "send":
      driver.sendText(arg);
      record("send", {
        type: "text",
        bytes: Buffer.byteLength(arg),
        text: arg.slice(0, 200),
      });
      return;
    case "send-hex": {
      const bytes = Buffer.from(arg, "hex");
      driver.sendBinary(bytes);
      record("send", {
        type: "binary",
        bytes: bytes.length,
        hex: arg.slice(0, 128),
      });
      return;
    }
    case "send-size":
      driver.sendText("x".repeat(Number(arg)));
      record("send", { type: "text", bytes: Number(arg) });
      return;
    case "expect": {
      const m = await nextMessage(`text "${arg}"`);
      if (m.kind !== "text" || m.text !== arg)
        throw new Error(
          `expected text "${arg}", got ${JSON.stringify(describe(m))}`,
        );
      return;
    }
    case "expect-hex": {
      const m = await nextMessage(`binary ${arg}`);
      if (m.kind !== "binary" || m.bytes.toString("hex") !== arg.toLowerCase())
        throw new Error(
          `expected binary ${arg}, got ${JSON.stringify(describe(m))}`,
        );
      return;
    }
    case "expect-json": {
      const m = await nextMessage(`JSON ${arg}`);
      const want = JSON.parse(arg);
      if (m.kind !== "text" || !isDeepStrictEqual(JSON.parse(m.text), want))
        throw new Error(
          `expected JSON ${arg}, got ${JSON.stringify(describe(m))}`,
        );
      return;
    }
    case "expect-size": {
      const m = await nextMessage(`a ${arg}-byte message`);
      const size =
        m.kind === "text" ? Buffer.byteLength(m.text) : m.bytes.length;
      if (size !== Number(arg))
        throw new Error(`expected ${arg} bytes, got ${size}`);
      return;
    }
    case "close": {
      const [code, ...reason] = arg ? arg.split(":") : [];
      driver.close(
        code ? Number(code) : undefined,
        reason.join(":") || undefined,
      );
      record("send", {
        type: "close",
        code: code ? Number(code) : null,
        reason: reason.join(":"),
      });
      return;
    }
    case "expect-close": {
      const c = await until(() => closed ?? undefined, `close ${arg}`);
      if (c.code !== Number(arg))
        throw new Error(`expected close ${arg}, got ${c.code} "${c.reason}"`);
      return;
    }
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, Number(arg)));
      return;
    default:
      throw new Error(`unknown step "${step}"`);
  }
}

let failure: string | null = null;
try {
  record("connect", {
    url,
    client: args.client,
    deflateOffered: args.client === "ours" ? args.deflate : "built-in default",
  });
  const driver = await (args.client === "ours"
    ? connectOurs()
    : connectBuiltin());
  record("open", { extensions: driver.extensions });
  for (const step of steps) {
    try {
      await runStep(step, driver);
      record("pass", { step });
    } catch (error) {
      failure = `${step}: ${(error as Error).message}`;
      record("fail", { step, reason: (error as Error).message });
      break;
    }
  }
  // finish with a clean closing handshake unless a step already closed
  if (!closed) {
    driver.close(1000);
    await until(() => closed ?? undefined, "the final close").catch(() => {});
  }
} catch (error) {
  failure = `connect: ${(error as Error).message}`;
  record("fail", { step: "connect", reason: (error as Error).message });
}

const summary = failure ? `FAIL ${failure}` : `PASS ${steps.length} steps`;
if (run) logCommand(run, "drive", failure ? 1 : 0, summary);
// the clients may hold the socket open a moment longer; the verdict is in,
// so exit once the output has been written
process.stdout.write(
  `${summary}\nTranscript: ${path.relative(process.cwd(), transcript)}\n`,
  () => process.exit(failure ? 1 : 0),
);
