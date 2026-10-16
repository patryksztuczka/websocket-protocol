// Server permessage-deflate tests (RFC 7692). Run with `pnpm test`. A raw TCP
// client sends the handshake and frames, so the tests control every bit.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";

import type {
  WebSocketConnection,
  WebSocketConnectionOptions,
} from "../lib/web-socket-connection.ts";
import { WebSocketServer } from "../lib/web-socket-server.ts";

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

interface Frame {
  fin: number;
  rsv: number;
  opcode: number;
  payload: Buffer;
}

/** Builds a masked client frame. `rsv` is the 3 reserved bits, 0b100 is RSV1. */
function frame(
  opcode: number,
  payload: Buffer | string,
  { fin = 1, rsv = 0 } = {},
): Buffer {
  const data = Buffer.from(payload);
  let header: Buffer;
  if (data.length <= 125) {
    header = Buffer.from([0, 0x80 | data.length]);
  } else if (data.length <= 65535) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = (fin << 7) | (rsv << 4) | opcode;
  const mask = randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

/** Compresses one message with an empty window (RFC 7692 section 7.2.1). */
function compress(data: Buffer | string): Buffer {
  return zlib
    .deflateRawSync(Buffer.from(data), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    })
    .subarray(0, -4);
}

// every raw socket, so a failed test can't leave one open and keep the
// server from closing
const sockets = new Set<net.Socket>();

/** A raw WebSocket client that reads the server's frames one by one. */
class RawClient {
  public socket: net.Socket;
  public response = "";
  private buffer = Buffer.alloc(0);
  private frames: Frame[] = [];
  private waiting: ((frame: Frame | undefined) => void)[] = [];
  private ended = false;
  // inflates the server's compressed messages, keeping the window between them
  private inflater: zlib.InflateRaw;

  constructor(socket: net.Socket, windowBits = 15) {
    this.socket = socket;
    this.inflater = zlib.createInflateRaw({ windowBits });
  }

  static async connect(port: number, extensions?: string) {
    const socket = net.connect(port, "127.0.0.1");
    sockets.add(socket);
    await once(socket, "connect");
    const client = new RawClient(socket);
    socket.write(
      "GET / HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        (extensions === undefined
          ? ""
          : `Sec-WebSocket-Extensions: ${extensions}\r\n`) +
        "\r\n",
    );
    await new Promise<void>((resolve) => {
      let head = Buffer.alloc(0);
      const onData = (data: Buffer) => {
        head = Buffer.concat([head, data]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.off("data", onData);
        client.response = head.subarray(0, end).toString("latin1");
        client.listen(head.subarray(end + 4));
        resolve();
      };
      socket.on("data", onData);
    });
    return client;
  }

  /** The value of a response header, or undefined. */
  header(name: string) {
    const match = new RegExp(`\r\n${name}: *([^\r]*)`, "i").exec(this.response);
    return match?.[1];
  }

  private listen(rest: Buffer) {
    this.socket.on("data", (data: Buffer) => this.read(data));
    this.socket.on("end", () => {
      this.ended = true;
      for (const resolve of this.waiting.splice(0)) resolve(undefined);
    });
    this.socket.on("error", () => {});
    this.read(rest);
  }

  private read(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const first = this.buffer[0]!;
      const received: Frame = {
        fin: first >> 7,
        rsv: (first >> 4) & 0b111,
        opcode: first & 0x0f,
        payload: this.buffer.subarray(offset, offset + length),
      };
      this.buffer = this.buffer.subarray(offset + length);
      const resolve = this.waiting.shift();
      if (resolve) resolve(received);
      else this.frames.push(received);
    }
  }

  /** Resolves with the next frame, or undefined once the server has closed the connection. */
  nextFrame(): Promise<Frame | undefined> {
    const next = this.frames.shift();
    if (next || this.ended) return Promise.resolve(next);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Inflates a compressed message from the server (RFC 7692 section 7.2.2). */
  inflate(payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => chunks.push(chunk);
      this.inflater.on("data", onData);
      this.inflater.once("error", reject);
      this.inflater.write(Buffer.concat([payload, TAIL]));
      this.inflater.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        this.inflater.off("data", onData);
        this.inflater.off("error", reject);
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /** Reads the next frame and expects a close frame with `code`. */
  async expectClose(code: number) {
    const received = await this.nextFrame();
    assert.ok(received, "expected a close frame, the connection ended");
    assert.equal(received.opcode, 0x8);
    assert.equal(received.payload.readUInt16BE(0), code);
  }

  close() {
    this.inflater.close();
    this.socket.destroy();
  }
}

/** Starts an echo server like test/scripts/server-test.ts on a free port. */
async function echoServer(options: WebSocketConnectionOptions) {
  const httpServer = createServer();
  const wsServer = new WebSocketServer(httpServer, options);
  wsServer.on("connect", (connection: WebSocketConnection) => {
    connection.addSocketEventListeners();
    connection.on("message", (message) =>
      connection.send("text", message.payload),
    );
    connection.on("binaryMessage", (message) =>
      connection.send("binary", message.payload),
    );
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  return {
    httpServer,
    port: (httpServer.address() as net.AddressInfo).port,
  };
}

// compressible text above the 1024-byte default threshold
const LONG_TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(60);

describe("server with perMessageDeflate", () => {
  let httpServer: Server;
  let port: number;

  before(async () => {
    ({ httpServer, port } = await echoServer({
      perMessageDeflate: true,
      maxMessageSize: 64 * 1024,
    }));
  });

  after(() => {
    for (const socket of sockets) socket.destroy();
    httpServer.close();
  });

  test("accepts the offer in the 101 response", async () => {
    const client = await RawClient.connect(
      port,
      "permessage-deflate; client_max_window_bits",
    );
    assert.match(client.response, /^HTTP\/1\.1 101 /);
    assert.equal(
      client.header("sec-websocket-extensions"),
      "permessage-deflate",
    );
    client.close();
  });

  test("answers server_no_context_takeover and server_max_window_bits", async () => {
    const client = await RawClient.connect(
      port,
      "permessage-deflate; server_no_context_takeover; server_max_window_bits=10; client_max_window_bits",
    );
    assert.equal(
      client.header("sec-websocket-extensions"),
      "permessage-deflate; server_no_context_takeover; server_max_window_bits=10",
    );
    client.close();
  });

  test("declines an offer it can't accept and works without compression", async () => {
    const client = await RawClient.connect(port, "permessage-deflate; foo=1");
    assert.equal(client.header("sec-websocket-extensions"), undefined);
    client.socket.write(frame(0x1, LONG_TEXT));
    const echo = await client.nextFrame();
    assert.equal(echo?.rsv, 0);
    assert.equal(echo?.payload.toString(), LONG_TEXT);
    client.close();
  });

  test("answers a malformed Sec-WebSocket-Extensions header with 400", async () => {
    const client = await RawClient.connect(port, "permessage-deflate; =");
    assert.match(client.response, /^HTTP\/1\.1 400 /);
    client.close();
  });

  test("inflates a compressed text message and sends the long echo compressed", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    client.socket.write(frame(0x1, compress(LONG_TEXT), { rsv: 0b100 }));
    const echo = await client.nextFrame();
    assert.ok(echo);
    assert.equal(echo.opcode, 0x1);
    assert.equal(echo.rsv, 0b100);
    assert.ok(echo.payload.length < LONG_TEXT.length / 4);
    assert.equal((await client.inflate(echo.payload)).toString(), LONG_TEXT);
    client.close();
  });

  test("sends a message below the threshold uncompressed", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    client.socket.write(frame(0x1, compress("Hello"), { rsv: 0b100 }));
    const echo = await client.nextFrame();
    assert.equal(echo?.rsv, 0);
    assert.equal(echo?.payload.toString(), "Hello");
    client.close();
  });

  test("reads uncompressed messages too", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    client.socket.write(frame(0x1, "Hello"));
    assert.equal((await client.nextFrame())?.payload.toString(), "Hello");
    client.close();
  });

  test("reads a compressed message split into fragments, RSV1 on the first only", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    const data = randomBytes(500);
    const compressed = compress(Buffer.concat([data, data, data, data]));
    const third = Math.floor(compressed.length / 3);
    client.socket.write(
      Buffer.concat([
        frame(0x2, compressed.subarray(0, third), { fin: 0, rsv: 0b100 }),
        frame(0x0, compressed.subarray(third, 2 * third), { fin: 0 }),
        // a ping between fragments is answered right away
        frame(0x9, "ping"),
        frame(0x0, compressed.subarray(2 * third)),
      ]),
    );
    const pong = await client.nextFrame();
    assert.equal(pong?.opcode, 0xa);
    const echo = await client.nextFrame();
    assert.equal(echo?.opcode, 0x2);
    assert.equal(echo?.rsv, 0b100);
    assert.deepEqual(
      await client.inflate(echo.payload),
      Buffer.concat([data, data, data, data]),
    );
    client.close();
  });

  test("takes over the window between messages", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    const message = randomBytes(2000).toString("base64");
    client.socket.write(frame(0x1, message));
    client.socket.write(frame(0x1, message));
    const first = await client.nextFrame();
    const second = await client.nextFrame();
    assert.ok(first && second);
    // the second refers back to the first instead of repeating it
    assert.ok(second.payload.length < first.payload.length / 10);
    assert.equal((await client.inflate(first.payload)).toString(), message);
    assert.equal((await client.inflate(second.payload)).toString(), message);
    client.close();
  });

  test("server_no_context_takeover compresses every message on its own", async () => {
    const client = await RawClient.connect(
      port,
      "permessage-deflate; server_no_context_takeover",
    );
    const message = randomBytes(2000).toString("base64");
    client.socket.write(frame(0x1, message));
    client.socket.write(frame(0x1, message));
    const first = await client.nextFrame();
    const second = await client.nextFrame();
    assert.ok(first && second);
    assert.deepEqual(second.payload, first.payload);
    client.close();
  });

  test("server_max_window_bits=8 replies decode with a 256-byte window", async () => {
    const client = await RawClient.connect(
      port,
      "permessage-deflate; server_max_window_bits=8",
    );
    assert.equal(
      client.header("sec-websocket-extensions"),
      "permessage-deflate; server_max_window_bits=8",
    );
    // the client inflates with a 256-byte window, one byte at a time, so a
    // back-reference further than 256 bytes fails
    const strict = zlib.createInflateRaw({ windowBits: 8, chunkSize: 64 });
    const inflateStrict = (payload: Buffer) =>
      new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer) => chunks.push(chunk);
        strict.on("data", onData);
        strict.once("error", reject);
        const input = Buffer.concat([payload, TAIL]);
        for (let i = 0; i < input.length; i++) {
          strict.write(input.subarray(i, i + 1));
        }
        strict.flush(zlib.constants.Z_SYNC_FLUSH, () => {
          strict.off("data", onData);
          resolve(Buffer.concat(chunks));
        });
      });
    for (let m = 0; m < 5; m++) {
      // repeats 300 bytes apart, out of reach of a 256-byte window
      const block = randomBytes(300).toString("base64");
      const message = block.repeat(4);
      client.socket.write(frame(0x1, message));
      const echo = await client.nextFrame();
      assert.equal(echo?.rsv, 0b100);
      assert.equal((await inflateStrict(echo.payload)).toString(), message);
    }
    strict.close();
    client.close();
  });

  test("delivers messages, pongs and the close in the order they arrived", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    const first = `first ${LONG_TEXT}`;
    const second = `second ${LONG_TEXT}`;
    // everything in one write, so the server reads the close frame while the
    // messages before it are still being inflated and compressed
    client.socket.write(
      Buffer.concat([
        frame(0x1, compress(first), { rsv: 0b100 }),
        frame(0x1, compress(second), { rsv: 0b100 }),
        frame(0x1, "third"),
        frame(0x9, "ping"),
        frame(0x8, Buffer.from([0x03, 0xe8])),
      ]),
    );
    const echo1 = await client.nextFrame();
    const echo2 = await client.nextFrame();
    const echo3 = await client.nextFrame();
    const pong = await client.nextFrame();
    assert.ok(echo1 && echo2 && echo3 && pong);
    assert.equal((await client.inflate(echo1.payload)).toString(), first);
    assert.equal((await client.inflate(echo2.payload)).toString(), second);
    assert.equal(echo3.payload.toString(), "third");
    assert.equal(pong.opcode, 0xa);
    await client.expectClose(1000);
    assert.equal(await client.nextFrame(), undefined);
    client.close();
  });

  test("a failed connection's close frame waits for the echo still being compressed", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    client.socket.write(
      Buffer.concat([
        frame(0x1, compress(LONG_TEXT), { rsv: 0b100 }),
        // RSV2 is never allowed
        frame(0x1, "Hello", { rsv: 0b010 }),
      ]),
    );
    const echo = await client.nextFrame();
    assert.equal(echo?.rsv, 0b100);
    assert.equal((await client.inflate(echo.payload)).toString(), LONG_TEXT);
    await client.expectClose(1002);
    client.close();
  });

  for (const [name, frames] of [
    [
      "RSV1 on a continuation frame",
      [
        frame(0x1, compress("Hel"), { fin: 0, rsv: 0b100 }),
        frame(0x0, "lo", { rsv: 0b100 }),
      ],
    ],
    ["RSV1 on a ping", [frame(0x9, "ping", { rsv: 0b100 })]],
    ["RSV1 on a close frame", [frame(0x8, "", { rsv: 0b100 })]],
    ["RSV3", [frame(0x1, "Hello", { rsv: 0b001 })]],
  ] as const) {
    test(`${name} closes with 1002`, async () => {
      const client = await RawClient.connect(port, "permessage-deflate");
      client.socket.write(Buffer.concat(frames));
      await client.expectClose(1002);
      client.close();
    });
  }

  test("a message that inflates past maxMessageSize closes with 1009", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    const bomb = compress(Buffer.alloc(10 * 1024 * 1024));
    assert.ok(bomb.length < 64 * 1024);
    client.socket.write(frame(0x2, bomb, { rsv: 0b100 }));
    await client.expectClose(1009);
    client.close();
  });

  test("text that isn't valid UTF-8 once inflated closes with 1007", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    client.socket.write(
      frame(0x1, compress(Buffer.from([0x48, 0xc0, 0xaf])), { rsv: 0b100 }),
    );
    await client.expectClose(1007);
    client.close();
  });

  test("data that can't be inflated closes with 1007", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    client.socket.write(
      frame(0x2, Buffer.from([0xff, 0xff, 0xff]), { rsv: 0b100 }),
    );
    await client.expectClose(1007);
    client.close();
  });
});

describe("server without perMessageDeflate (the default)", () => {
  let httpServer: Server;
  let port: number;

  before(async () => {
    ({ httpServer, port } = await echoServer({}));
  });

  after(() => {
    for (const socket of sockets) socket.destroy();
    httpServer.close();
  });

  test("ignores the offer, and RSV1 closes with 1002", async () => {
    const client = await RawClient.connect(port, "permessage-deflate");
    assert.equal(client.header("sec-websocket-extensions"), undefined);
    client.socket.write(frame(0x1, compress("Hello"), { rsv: 0b100 }));
    await client.expectClose(1002);
    client.close();
  });
});
