#!/usr/bin/env node
// Speaks the protocol byte by byte: sends an opening handshake you can bend,
// then frames you build, and records every frame the server sends back. Use
// it for what a normal client won't do (unmasked or broken frames, bad
// handshakes) and to see frames a client API hides (pings, RSV bits, close
// payloads). Writes a transcript and exits 1 if any step fails.
//
//   raw.ts --run <id> --path /echo [--header "Name: value"]... [--omit-header Name]...
//          [--name <transcript>] [--timeout <ms>] [--no-wait] <step>...
//   raw.ts --url ws://host:port/path --out <dir> ...
//
// A frame spec is <opcode>[,fin=0|1][,mask=0|1][,rsv=0-7]; the opcode is
// cont, text, binary, close, ping, pong or a number 0-15. Defaults: fin=1,
// mask=1, rsv=0.
//
// --no-wait starts the steps right after sending the handshake instead of
// waiting for the answer, e.g. "wait:100 end" leaves before the server answers.
//
// Steps:
//   frame:<spec>:<text>      send a frame with this UTF-8 payload
//   frame-hex:<spec>:<hex>   send a frame with these payload bytes
//   frame-size:<spec>:<n>    send a frame with n "a" characters as payload
//   close[:<code>[:<reason>]]  send a masked close frame
//   bytes:<hex>              write raw bytes to the socket
//   end                      half-close the TCP connection (send FIN)
//   wait:<ms>                pause
//   expect-status:<n>        the handshake answer had this HTTP status
//   expect-header:<name>:<value>  the handshake answer had this header value
//   expect-frame:<spec>[:<text>]  the next frame has this opcode (and fin/rsv
//                            if given) and, if given, this UTF-8 payload
//   expect-close:<code>      the next frame is a close frame with this code
//   expect-eof               the server closes the TCP connection
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { parseArgs } from "node:util";

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
    header: { type: "string", multiple: true, default: [] },
    "omit-header": { type: "string", multiple: true, default: [] },
    name: { type: "string" },
    timeout: { type: "string", default: "5000" },
    "no-wait": { type: "boolean", default: false },
  },
});

const external = args.url !== undefined;
const run = external ? null : requireRun(args.run);
const state = run ? readState(run) : null;
const url = new URL(args.url ?? `${state?.url}${args.path}`);
const outDir = args.out ?? (run ? path.join(runDir(run), "transcripts") : null);
if (!outDir) throw new Error("Pass --out <dir> with --url");
const timeoutMs = Number(args.timeout);
const name = args.name ?? `raw-${Date.now()}`;
const transcript = path.join(outDir, `${name}.jsonl`);
mkdirSync(outDir, { recursive: true });

const record = (kind: string, details: Record<string, unknown> = {}) => {
  appendFileSync(
    transcript,
    JSON.stringify({ t: new Date().toISOString(), kind, ...details }) + "\n",
  );
  console.log(`${kind} ${JSON.stringify(details)}`);
};

const OPCODES: Record<string, number> = {
  cont: 0,
  text: 1,
  binary: 2,
  close: 8,
  ping: 9,
  pong: 10,
};
const opcodeName = (n: number) =>
  Object.keys(OPCODES).find((k) => OPCODES[k] === n) ?? String(n);

interface Spec {
  opcode: number;
  fin?: number;
  mask?: number;
  rsv?: number;
}

function parseSpec(text: string): Spec {
  const [op = "", ...flags] = text.split(",");
  const opcode = op in OPCODES ? (OPCODES[op] as number) : Number(op);
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 15)
    throw new Error(`unknown opcode "${op}"`);
  const spec: Spec = { opcode };
  for (const flag of flags) {
    const [key, value] = flag.split("=");
    if (key !== "fin" && key !== "mask" && key !== "rsv")
      throw new Error(`unknown frame flag "${flag}"`);
    spec[key] = Number(value);
  }
  return spec;
}

/** Splits "a:b:rest:with:colons" into ["a", "b", "rest:with:colons"]. */
function splitStep(step: string, parts: number) {
  const out: string[] = [];
  let rest = step;
  for (let i = 1; i < parts; i++) {
    const colon = rest.indexOf(":");
    if (colon === -1) break;
    out.push(rest.slice(0, colon));
    rest = rest.slice(colon + 1);
  }
  out.push(rest);
  return out;
}

function buildFrame(spec: Spec, payload: Buffer) {
  const fin = spec.fin ?? 1;
  const mask = spec.mask ?? 1;
  const rsv = spec.rsv ?? 0;
  const head = [(fin << 7) | (rsv << 4) | spec.opcode];
  let length: Buffer;
  if (payload.length < 126) {
    head.push((mask << 7) | payload.length);
    length = Buffer.alloc(0);
  } else if (payload.length < 65536) {
    head.push((mask << 7) | 126);
    length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length);
  } else {
    head.push((mask << 7) | 127);
    length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
  }
  if (!mask) return Buffer.concat([Buffer.from(head), length, payload]);
  const key = randomBytes(4);
  const masked = Buffer.from(
    payload.map((byte, i) => byte ^ (key[i % 4] as number)),
  );
  return Buffer.concat([Buffer.from(head), length, key, masked]);
}

interface Frame {
  fin: number;
  rsv: number;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

function describeFrame(frame: Frame) {
  const details: Record<string, unknown> = {
    opcode: opcodeName(frame.opcode),
    fin: frame.fin,
    rsv: frame.rsv,
    masked: frame.masked,
    bytes: frame.payload.length,
  };
  if (frame.opcode === 8 && frame.payload.length >= 2) {
    details["code"] = frame.payload.readUInt16BE(0);
    details["reason"] = frame.payload.subarray(2).toString("utf8");
  } else if ([1, 9, 10].includes(frame.opcode) && frame.rsv === 0) {
    details["text"] = frame.payload.subarray(0, 200).toString("utf8");
  } else {
    details["hex"] = frame.payload.subarray(0, 64).toString("hex");
  }
  return details;
}

// ---- connection and handshake

const key = randomBytes(16).toString("base64");
const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
const headers = new Map<string, string>([
  ["Host", `${url.hostname}:${port}`],
  ["Upgrade", "websocket"],
  ["Connection", "Upgrade"],
  ["Sec-WebSocket-Key", key],
  ["Sec-WebSocket-Version", "13"],
]);
const setHeader = (name: string, value: string | null) => {
  for (const existing of headers.keys()) {
    if (existing.toLowerCase() === name.toLowerCase()) headers.delete(existing);
  }
  if (value !== null) headers.set(name, value);
};
for (const line of args.header) {
  const colon = line.indexOf(":");
  setHeader(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
}
for (const name of args["omit-header"]) setHeader(name, null);

const socket: net.Socket =
  url.protocol === "wss:"
    ? tls.connect({
        host: url.hostname,
        port,
        servername: url.hostname,
        ca: readFileSync(fixtureCert),
      })
    : net.connect({ host: url.hostname, port });

let buffer = Buffer.alloc(0);
let handshake: { status: number; headers: Record<string, string> } | null =
  null;
const frames: Frame[] = [];
let eof = false;
let wake: (() => void) | null = null;
const notify = () => {
  wake?.();
  wake = null;
};

function parseFrames() {
  for (;;) {
    if (buffer.length < 2) return;
    const b0 = buffer[0] as number;
    const b1 = buffer[1] as number;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return;
    let payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey)
      payload = Buffer.from(
        payload.map((byte, i) => byte ^ (maskKey[i % 4] as number)),
      );
    buffer = buffer.subarray(offset + length);
    const frame = {
      fin: b0 >> 7,
      rsv: (b0 >> 4) & 0x7,
      opcode: b0 & 0xf,
      masked,
      payload,
    };
    frames.push(frame);
    record("recv-frame", describeFrame(frame));
  }
}

socket.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!handshake) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const [statusLine = "", ...lines] = buffer
      .subarray(0, end)
      .toString("latin1")
      .split("\r\n");
    const answer: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      answer[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
    handshake = { status: Number(statusLine.split(" ")[1]), headers: answer };
    buffer = buffer.subarray(end + 4);
    const expectedAccept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    record("handshake", {
      statusLine,
      headers: answer,
      ...(handshake.status === 101
        ? { acceptValid: answer["sec-websocket-accept"] === expectedAccept }
        : {}),
    });
    if (handshake.status !== 101) {
      if (buffer.length)
        record("http-body", { text: buffer.toString("utf8").slice(0, 500) });
      buffer = Buffer.alloc(0);
    }
  }
  if (handshake?.status === 101) parseFrames();
  notify();
});
socket.on("end", () => {
  eof = true;
  record("eof");
  notify();
});
socket.on("close", () => {
  eof = true;
  notify();
});
socket.on("error", (error) => {
  record("socket-error", { message: error.message });
  eof = true;
  notify();
});

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

const nextFrame = (what: string) =>
  until(() => frames.shift() ?? (eof ? null : undefined), what).then((f) => {
    if (f === null)
      throw new Error(`connection closed while waiting for ${what}`);
    return f;
  });

function write(bytes: Buffer, details: Record<string, unknown>) {
  if (!handshake || handshake.status !== 101)
    throw new Error("no open WebSocket connection to send on");
  socket.write(bytes);
  record("send", details);
}

async function runStep(step: string) {
  const [op = ""] = splitStep(step, 2);
  switch (op) {
    case "frame":
    case "frame-hex":
    case "frame-size": {
      const [, specText = "", data = ""] = splitStep(step, 3);
      const spec = parseSpec(specText);
      const payload =
        op === "frame"
          ? Buffer.from(data, "utf8")
          : op === "frame-hex"
            ? Buffer.from(data, "hex")
            : Buffer.alloc(Number(data), "a");
      write(buildFrame(spec, payload), {
        frame: specText,
        bytes: payload.length,
      });
      return;
    }
    case "close": {
      const [, code, reason = ""] = splitStep(step, 3);
      let payload = Buffer.alloc(0);
      if (code) {
        payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(Number(code));
        payload.write(reason, 2);
      }
      write(buildFrame({ opcode: 8 }, payload), {
        frame: "close",
        code: code ? Number(code) : null,
        reason,
      });
      return;
    }
    case "bytes": {
      const [, hex = ""] = splitStep(step, 2);
      write(Buffer.from(hex, "hex"), { bytes: hex });
      return;
    }
    case "end":
      socket.end();
      record("send", { fin: true });
      return;
    case "wait": {
      const [, ms = "0"] = splitStep(step, 2);
      await new Promise((resolve) => setTimeout(resolve, Number(ms)));
      return;
    }
    case "expect-status": {
      const [, status] = splitStep(step, 2);
      if (handshake?.status !== Number(status))
        throw new Error(`expected status ${status}, got ${handshake?.status}`);
      return;
    }
    case "expect-header": {
      const [, header = "", value = ""] = splitStep(step, 3);
      const actual = handshake?.headers[header.toLowerCase()];
      if (actual !== value)
        throw new Error(
          `expected ${header}: ${value}, got ${actual ?? "(missing)"}`,
        );
      return;
    }
    case "expect-frame": {
      const [, specText = "", text] = splitStep(step, 3);
      const spec = parseSpec(specText);
      const frame = await nextFrame(`a ${specText} frame`);
      const mismatch =
        frame.opcode !== spec.opcode ||
        (spec.fin !== undefined && frame.fin !== spec.fin) ||
        (spec.rsv !== undefined && frame.rsv !== spec.rsv) ||
        (text !== undefined && frame.payload.toString("utf8") !== text);
      if (mismatch)
        throw new Error(
          `expected ${specText}${text === undefined ? "" : ` "${text}"`}, got ${JSON.stringify(describeFrame(frame))}`,
        );
      return;
    }
    case "expect-close": {
      const [, code] = splitStep(step, 2);
      const frame = await nextFrame(`close ${code}`);
      const actual =
        frame.opcode === 8 && frame.payload.length >= 2
          ? frame.payload.readUInt16BE(0)
          : null;
      if (frame.opcode !== 8 || actual !== Number(code))
        throw new Error(
          `expected close ${code}, got ${JSON.stringify(describeFrame(frame))}`,
        );
      return;
    }
    case "expect-eof":
      await until(() => (eof ? true : undefined), "the server to close TCP");
      return;
    default:
      throw new Error(`unknown step "${step}"`);
  }
}

let failure: string | null = null;
try {
  await new Promise<void>((resolve, reject) => {
    socket.once(url.protocol === "wss:" ? "secureConnect" : "connect", resolve);
    socket.once("error", reject);
  });
  const request = `GET ${url.pathname}${url.search} HTTP/1.1\r\n${[...headers].map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
  record("handshake-request", { request: request.trimEnd().split("\r\n") });
  socket.write(request);
  if (!args["no-wait"]) {
    await until(
      () => handshake ?? (eof ? null : undefined),
      "the handshake answer",
    ).then((h) => {
      if (h === null)
        throw new Error(
          "server closed the connection without answering the handshake",
        );
    });
  }
  for (const step of steps) {
    try {
      await runStep(step);
      record("pass", { step });
    } catch (error) {
      failure = `${step}: ${(error as Error).message}`;
      record("fail", { step, reason: (error as Error).message });
      break;
    }
  }
} catch (error) {
  failure = `connect: ${(error as Error).message}`;
  record("fail", { step: "connect", reason: (error as Error).message });
}
socket.destroy();

const summary = failure ? `FAIL ${failure}` : `PASS ${steps.length} steps`;
if (run) logCommand(run, "raw", failure ? 1 : 0, summary);
process.stdout.write(
  `${summary}\nTranscript: ${path.relative(process.cwd(), transcript)}\n`,
  () => process.exit(failure ? 1 : 0),
);
