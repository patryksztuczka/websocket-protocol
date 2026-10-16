// Client tests. Run with `pnpm test`. Each test starts its own server on a free
// port, so nothing else needs to be running.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type OutgoingHttpHeaders, type Server } from "node:http";
import https from "node:https";
import net from "node:net";
import { after, before, describe, test, type TestContext } from "node:test";
import tls from "node:tls";
import zlib from "node:zlib";

import {
  WebSocketClient,
  type WebSocketClientOptions,
} from "../lib/web-socket-client.ts";
import type {
  WebSocketConnection,
  WebSocketConnectionOptions,
} from "../lib/web-socket-connection.ts";
import { WebSocketServer } from "../lib/web-socket-server.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type Message = { type: "text" | "binary"; payload: string | Buffer };

// A self-signed certificate for localhost and 127.0.0.1 that expires in 2126,
// made with:
//   openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
//     -subj "/CN=localhost" \
//     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
//     -keyout test/fixtures/localhost-key.pem -out test/fixtures/localhost-cert.pem
const cert = readFileSync(
  new URL("fixtures/localhost-cert.pem", import.meta.url),
);
const key = readFileSync(
  new URL("fixtures/localhost-key.pem", import.meta.url),
);

// how long a test waits for a connection or a message before it fails
const WAIT_TIMEOUT_MS = 3000;

// the TCP connections each test server has open, so stop() can drop them
const openSockets = new WeakMap<net.Server, Set<net.Socket>>();

/** Resolves with the port once the server listens on a free one. */
async function listen(server: net.Server | Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  openSockets.set(server, sockets);
  // a tls.Server emits the plain TCP socket here, before the TLS handshake
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

/**
 * Closes the server and drops every connection it still has, so a test that
 * failed halfway can't keep the process running.
 */
function stop(server: net.Server | Server) {
  server.close();
  for (const socket of openSockets.get(server) ?? []) socket.destroy();
}

/** Rejects if `promise` hasn't settled after WAIT_TIMEOUT_MS. */
function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${what}`)),
      WAIT_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Connects and resolves with the connection, or rejects with the failure reason. */
function connect(
  url: string,
  options?: WebSocketClientOptions,
): Promise<WebSocketConnection> {
  const connected = new Promise<WebSocketConnection>((resolve, reject) => {
    const client = new WebSocketClient();
    client.on("connect", resolve);
    client.on("connectionFailed", (reason: string) =>
      reject(new Error(reason)),
    );
    client.connect(url, options);
  });
  return withTimeout(connected, `a connection to ${url}`);
}

/** Resolves with the next text or binary message on the connection. */
function nextMessage(connection: WebSocketConnection): Promise<Message> {
  const message = new Promise<Message>((resolve) => {
    connection.once("message", resolve);
    connection.once("binaryMessage", resolve);
  });
  return withTimeout(message, "a message");
}

/** Closes the connection with the closing handshake. */
function end(connection: WebSocketConnection) {
  connection.close();
}

/**
 * A raw TCP server that reads the client's handshake request and answers with
 * whatever `respond` returns, so tests can send answers the real server never would.
 * With `secure` it speaks TLS with the fixture certificate and gives a wss: address.
 * The server stops once the test `t` has finished.
 */
async function fakeServer(
  t: TestContext,
  respond: (key: string) => string | Buffer,
  { secure = false } = {},
) {
  const sockets: net.Socket[] = [];
  const onConnection = (socket: net.Socket) => {
    sockets.push(socket);
    let request = "";
    socket.on("data", (data) => {
      request += data.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key: *(\S+)/i.exec(request)?.[1] ?? "";
      socket.write(respond(key));
    });
    // the client may drop the connection at any point
    socket.on("error", () => {});
  };
  const server = secure
    ? tls.createServer({ cert, key }, onConnection)
    : net.createServer(onConnection);
  const port = await listen(server);
  t.after(() => stop(server));
  const scheme = secure ? "wss" : "ws";
  return { server, sockets, url: `${scheme}://127.0.0.1:${port}/` };
}

/** Answers with the same behaviour as test/scripts/server-test.ts. */
function echo(connection: WebSocketConnection) {
  connection.addSocketEventListeners();
  connection.on("message", (message) =>
    connection.send("text", message.payload),
  );
  connection.on("binaryMessage", (message) =>
    connection.send("binary", message.payload),
  );
}

function acceptKey(key: string) {
  return createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
}

describe("client against the echo server", () => {
  let httpServer: Server;
  let url: string;

  before(async () => {
    httpServer = createServer();
    const wsServer = new WebSocketServer(httpServer);
    wsServer.on("connect", echo);
    url = `ws://127.0.0.1:${await listen(httpServer)}/chat`;
  });

  after(() => {
    stop(httpServer);
  });

  test("echoes text, including emoji", async () => {
    const connection = await connect(url);
    const reply = nextMessage(connection);
    connection.send("text", "Hello world 👋 zażółć");
    assert.deepEqual(await reply, {
      type: "text",
      payload: "Hello world 👋 zażółć",
    });
    end(connection);
  });

  test("echoes binary", async () => {
    const connection = await connect(url);
    const reply = nextMessage(connection);
    const data = Buffer.from([0x00, 0x01, 0x80, 0xfe, 0xff]);
    connection.send("binary", data);
    assert.deepEqual(await reply, { type: "binary", payload: data });
    end(connection);
  });

  test("echoes a 70000-byte message, which needs the 64-bit length", async () => {
    const connection = await connect(url);
    const reply = nextMessage(connection);
    const text = "abcdefghij".repeat(7000);
    connection.send("text", text);
    assert.deepEqual(await reply, { type: "text", payload: text });
    end(connection);
  });

  test("close() finishes the closing handshake with the server", async () => {
    const connection = await connect(url);
    const closed = once(connection, "close");
    connection.close(1000, "bye");
    // the event reports the server's close frame: it echoes the code, not
    // the reason (RFC 6455 section 5.5.1), then ends the TCP connection
    assert.deepEqual(await closed, [1000, ""]);
    assert.equal(connection.readyState, "closed");
  });
});

describe("client handshake", () => {
  test("a refused connection emits connectionFailed", async () => {
    // take a free port and close it again, so nothing listens there
    const server = net.createServer();
    const port = await listen(server);
    server.close();
    await once(server, "close");

    await assert.rejects(connect(`ws://127.0.0.1:${port}/`), /ECONNREFUSED/);
  });

  test("a wrong Sec-WebSocket-Accept emits connectionFailed and drops the connection", async (t) => {
    const fake = await fakeServer(
      t,
      () =>
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey("not the key the client sent")}\r\n` +
        "\r\n",
    );

    await assert.rejects(connect(fake.url), /Invalid sec-websocket-accept/);
    // the client closed its end of the TCP connection
    const [socket] = fake.sockets;
    assert.ok(socket);
    if (!socket.readableEnded) await once(socket, "end");
  });

  test("a response other than 101 emits connectionFailed", async (t) => {
    const fake = await fakeServer(
      t,
      () => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
    );

    await assert.rejects(connect(fake.url), /status 404/);
  });

  test("accepts Upgrade and Connection values in any case and reads a frame sent with the 101", async (t) => {
    const fake = await fakeServer(t, (key) =>
      Buffer.concat([
        Buffer.from(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: WebSocket\r\n" +
            "Connection: keep-alive, Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
            "\r\n",
        ),
        // an unmasked text frame "hi" in the same write as the answer
        Buffer.from([0x81, 0x02, 0x68, 0x69]),
      ]),
    );

    const connection = await connect(fake.url);
    assert.deepEqual(await nextMessage(connection), {
      type: "text",
      payload: "hi",
    });
    end(connection);
  });

  test("sends the path, query and Host with a non-default port", async (t) => {
    let request = "";
    const fake = await fakeServer(t, () => "HTTP/1.1 400 Bad Request\r\n\r\n");
    fake.server.on("connection", (socket: net.Socket) =>
      socket.on("data", (data) => (request += data.toString("latin1"))),
    );
    const port = (fake.server.address() as net.AddressInfo).port;

    await assert.rejects(connect(`ws://127.0.0.1:${port}/chat?room=1`));
    assert.match(request, /^GET \/chat\?room=1 HTTP\/1\.1\r\n/);
    assert.match(request, new RegExp(`\r\nhost: 127.0.0.1:${port}\r\n`, "i"));
    assert.match(request, /\r\nsec-websocket-version: 13\r\n/i);
  });

  test("rejects schemes other than ws: and wss:", () => {
    const client = new WebSocketClient();
    assert.throws(
      () => client.connect("http://127.0.0.1/"),
      /expected ws: or wss:/,
    );
    assert.throws(
      () => client.connect("https://127.0.0.1/"),
      /expected ws: or wss:/,
    );
  });
});

describe("client over wss:// against the echo server", () => {
  let httpsServer: https.Server;
  let port: number;
  let url: string;
  // trust the self-signed fixture certificate
  const options: WebSocketClientOptions = { tls: { ca: cert } };

  before(async () => {
    httpsServer = https.createServer({ cert, key });
    const wsServer = new WebSocketServer(httpsServer);
    wsServer.on("connect", echo);
    port = await listen(httpsServer);
    url = `wss://127.0.0.1:${port}/chat`;
  });

  after(() => {
    stop(httpsServer);
  });

  test("echoes text, including emoji", async () => {
    const connection = await connect(url, options);
    const reply = nextMessage(connection);
    connection.send("text", "Hello world 👋 zażółć");
    assert.deepEqual(await reply, {
      type: "text",
      payload: "Hello world 👋 zażółć",
    });
    end(connection);
  });

  test("echoes binary", async () => {
    const connection = await connect(url, options);
    const reply = nextMessage(connection);
    const data = Buffer.from([0x00, 0x01, 0x80, 0xfe, 0xff]);
    connection.send("binary", data);
    assert.deepEqual(await reply, { type: "binary", payload: data });
    end(connection);
  });

  test("an untrusted certificate emits connectionFailed with the reason", async () => {
    // without the ca option the self-signed certificate is not trusted
    await assert.rejects(connect(url), /Request failed: .*certificate/);
  });

  test("passes TLS options through, such as rejectUnauthorized", async () => {
    const connection = await connect(url, {
      tls: { rejectUnauthorized: false },
    });
    const reply = nextMessage(connection);
    connection.send("text", "unchecked");
    assert.deepEqual(await reply, { type: "text", payload: "unchecked" });
    end(connection);
  });

  test("checks the certificate against servername when it is set", async () => {
    // the certificate is valid for localhost, so this passes
    const connection = await connect(url, {
      tls: { ca: cert, servername: "localhost" },
    });
    end(connection);

    await assert.rejects(
      connect(url, { tls: { ca: cert, servername: "wrong.example" } }),
      /Request failed: .*does not match certificate's altnames/,
    );
  });

  test("TLS options can't change where the client connects or what it sends", async () => {
    // none of these are allowed by the type; this checks the client also
    // ignores them when they get through anyway
    const tlsOptions = {
      ca: cert,
      host: "203.0.113.1",
      hostname: "203.0.113.1",
      port: 1,
      path: "/elsewhere",
      socketPath: "/nonexistent.sock",
      headers: { upgrade: "nothing" },
    } as unknown as WebSocketClientOptions["tls"];

    const connection = await connect(url, { tls: tlsOptions });
    const reply = nextMessage(connection);
    connection.send("text", "still here");
    assert.deepEqual(await reply, { type: "text", payload: "still here" });
    end(connection);
  });

  test("wss://host/ with no port uses 443 and leaves the port out of Host", async (t) => {
    // nothing listens on 443 here, so send the request on to the test server
    // and keep the options the client asked for
    const realRequest = https.request;
    let asked: https.RequestOptions | undefined;
    t.mock.method(https, "request", (requestOptions: https.RequestOptions) => {
      asked = requestOptions;
      return realRequest({ ...requestOptions, hostname: "127.0.0.1", port });
    });

    const connection = await connect("wss://localhost/chat", options);
    assert.equal(asked?.port, 443);
    assert.equal(asked?.hostname, "localhost");
    const headers = asked?.headers as OutgoingHttpHeaders | undefined;
    assert.equal(headers?.["host"], "localhost");
    end(connection);
  });

  test("reads a frame sent in the same TLS record as the 101", async (t) => {
    const fake = await fakeServer(
      t,
      (key) =>
        Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
              "\r\n",
          ),
          // an unmasked text frame "hi" in the same write as the answer
          Buffer.from([0x81, 0x02, 0x68, 0x69]),
        ]),
      { secure: true },
    );

    const connection = await connect(fake.url, options);
    assert.deepEqual(await nextMessage(connection), {
      type: "text",
      payload: "hi",
    });
    end(connection);
  });
});

/**
 * A 101 answer that accepts the handshake, with a Sec-WebSocket-Extensions
 * header if given and `frames` sent in the same write. fakeServer calls
 * `respond` again for every chunk the client sends after its request, so
 * each handshake is answered only once.
 */
function accept(extensions?: string, frames = Buffer.alloc(0)) {
  const answered = new Set<string>();
  return (key: string) => {
    if (answered.has(key)) return "";
    answered.add(key);
    return Buffer.concat([Buffer.from(answerWith(key, extensions)), frames]);
  };
}

/** The 101 answer to the handshake with `key`. */
function answerWith(key: string, extensions?: string) {
  return (
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
    (extensions === undefined
      ? ""
      : `Sec-WebSocket-Extensions: ${extensions}\r\n`) +
    "\r\n"
  );
}

/** Collects everything clients send to `server`: the handshake request, then frames. */
function record(server: net.Server) {
  const received = { data: Buffer.alloc(0) };
  server.on("connection", (socket: net.Socket) =>
    socket.on("data", (data: Buffer) => {
      received.data = Buffer.concat([received.data, data]);
    }),
  );
  return received;
}

interface ClientFrame {
  rsv: number;
  opcode: number;
  payload: Buffer;
}

/** Reads the masked frames that follow the handshake request in `data`. */
function clientFrames(data: Buffer) {
  const frames: ClientFrame[] = [];
  let offset = data.indexOf("\r\n\r\n") + 4;
  while (offset + 2 <= data.length) {
    assert.equal(data[offset + 1]! & 0x80, 0x80, "client frames are masked");
    let length = data[offset + 1]! & 0x7f;
    let start = offset + 2;
    if (length === 126) {
      length = data.readUInt16BE(start);
      start += 2;
    } else if (length === 127) {
      length = Number(data.readBigUInt64BE(start));
      start += 8;
    }
    if (start + 4 + length > data.length) break;
    const mask = data.subarray(start, start + 4);
    const payload = Buffer.from(data.subarray(start + 4, start + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
    frames.push({
      rsv: (data[offset]! >> 4) & 0b111,
      opcode: data[offset]! & 0x0f,
      payload,
    });
    offset = start + 4 + length;
  }
  return frames;
}

/**
 * Resolves with the frames the client sent to a recorded server once there
 * are `count` of them. Rejects after WAIT_TIMEOUT_MS and stops checking, so a
 * failed test doesn't keep the process running.
 */
async function waitForFrames(
  received: { data: Buffer },
  count: number,
): Promise<ClientFrame[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const found = clientFrames(received.data);
    if (found.length >= count) return found;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} frames from the client`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/** Inflates one compressed message with a fresh 32 KiB window. */
function inflate(payload: Buffer) {
  return zlib.inflateRawSync(Buffer.concat([payload, TAIL]), {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  });
}

/**
 * Inflates `messages` one after another with a strict window of 256 bytes:
 * one input byte at a time into a 64-byte output buffer, so a back-reference
 * further than 256 bytes fails with "invalid distance too far back".
 */
async function strictInflate256(messages: Buffer[]) {
  const stream = zlib.createInflateRaw({ windowBits: 8, chunkSize: 64 });
  const results: Buffer[] = [];
  try {
    for (const message of messages) {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => chunks.push(chunk);
      stream.on("data", onData);
      const input = Buffer.concat([message, TAIL]);
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        for (let i = 0; i < input.length; i++) {
          stream.write(input.subarray(i, i + 1));
        }
        stream.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve());
      });
      stream.off("data", onData);
      results.push(Buffer.concat(chunks));
    }
  } finally {
    stream.close();
  }
  return results;
}

// compressible text above the 1024-byte default threshold
const LONG_TEXT = "Zażółć gęślą jaźń 👋 ".repeat(80);

// a 300-byte block repeated: a 32 KiB window compresses it by referring 300
// bytes back, which a 256-byte window can't follow
const FAR_REPEATS = randomBytes(300).toString("hex").repeat(8);

describe("client with perMessageDeflate against the server", () => {
  const servers: Server[] = [];

  /** An echo server like test/scripts/server-test.ts with the given options. */
  async function echoServer(options: WebSocketConnectionOptions) {
    const httpServer = createServer();
    servers.push(httpServer);
    const wsServer = new WebSocketServer(httpServer, options);
    wsServer.on("connect", echo);
    return `ws://127.0.0.1:${await listen(httpServer)}/`;
  }

  /** Sends every message at once and resolves with the echoes, in the order they came. */
  async function echoAll(connection: WebSocketConnection, messages: Message[]) {
    const echoes: Message[] = [];
    const done = new Promise<void>((resolve) => {
      const onMessage = (message: Message) => {
        echoes.push(message);
        if (echoes.length === messages.length) resolve();
      };
      connection.on("message", onMessage);
      connection.on("binaryMessage", onMessage);
    });
    for (const message of messages) {
      connection.send(message.type, message.payload);
    }
    await withTimeout(done, "the echoes");
    return echoes;
  }

  // long and short, text and binary, so some go compressed and some plain
  const messages: Message[] = Array.from({ length: 40 }, (_, i) =>
    i % 3 === 0
      ? { type: "text", payload: `${i} ${LONG_TEXT}` }
      : i % 3 === 1
        ? { type: "binary", payload: Buffer.alloc(2000 + i, i) }
        : { type: "text", payload: `short ${i}` },
  );

  after(() => {
    for (const server of servers) stop(server);
  });

  test("echoes compressed and plain messages in order", async () => {
    const url = await echoServer({ perMessageDeflate: true });
    const connection = await connect(url, { perMessageDeflate: true });
    assert.deepEqual(await echoAll(connection, messages), messages);
    end(connection);
  });

  test("works when the server asks for no context takeover and small windows", async () => {
    const url = await echoServer({
      perMessageDeflate: {
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        serverMaxWindowBits: 9,
        clientMaxWindowBits: 9,
      },
    });
    const connection = await connect(url, { perMessageDeflate: true });
    assert.deepEqual(await echoAll(connection, messages), messages);
    end(connection);
  });

  test("works when the client asks for window 8 and no context takeover", async () => {
    const url = await echoServer({ perMessageDeflate: true });
    const connection = await connect(url, {
      perMessageDeflate: {
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        serverMaxWindowBits: 8,
        clientMaxWindowBits: 8,
        threshold: 0,
      },
    });
    assert.deepEqual(await echoAll(connection, messages), messages);
    end(connection);
  });

  test("connects without compression to a server that has it off", async () => {
    const url = await echoServer({});
    const connection = await connect(url, { perMessageDeflate: true });
    assert.deepEqual(await echoAll(connection, messages), messages);
    end(connection);
  });
});

describe("client compression handshake", () => {
  test("makes no offer unless perMessageDeflate is on", async (t) => {
    const fake = await fakeServer(t, accept());
    const received = record(fake.server);
    const connection = await connect(fake.url);
    assert.doesNotMatch(
      received.data.toString("latin1"),
      /sec-websocket-extensions/i,
    );
    end(connection);
  });

  test("offers permessage-deflate with the chosen settings", async (t) => {
    for (const [options, offer] of [
      [true, "permessage-deflate; client_max_window_bits"],
      [
        {
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
          clientMaxWindowBits: 12,
          serverMaxWindowBits: 10,
        },
        "permessage-deflate; client_no_context_takeover; " +
          "server_no_context_takeover; server_max_window_bits=10; " +
          "client_max_window_bits=12",
      ],
    ] as const) {
      const fake = await fakeServer(t, accept());
      const received = record(fake.server);
      const connection = await connect(fake.url, {
        perMessageDeflate: options,
      });
      assert.ok(
        received.data
          .toString("latin1")
          .toLowerCase()
          .includes(`\r\nsec-websocket-extensions: ${offer}\r\n`),
      );
      end(connection);
    }
  });

  test("compresses the messages it sends: RSV1 set, masked, smaller", async (t) => {
    const fake = await fakeServer(t, accept("permessage-deflate"));
    const received = record(fake.server);
    const connection = await connect(fake.url, { perMessageDeflate: true });
    connection.send("text", LONG_TEXT);
    connection.send("text", "Hello");
    const [long, short] = await waitForFrames(received, 2);
    assert.ok(long && short);
    assert.equal(long.opcode, 0x1);
    assert.equal(long.rsv, 0b100);
    assert.ok(long.payload.length < Buffer.byteLength(LONG_TEXT) / 4);
    assert.equal(inflate(long.payload).toString(), LONG_TEXT);
    // below the threshold it goes plain
    assert.equal(short.rsv, 0);
    assert.equal(short.payload.toString(), "Hello");
    end(connection);
  });

  test("threshold: 0 compresses short messages too", async (t) => {
    const fake = await fakeServer(t, accept("permessage-deflate"));
    const received = record(fake.server);
    const connection = await connect(fake.url, {
      perMessageDeflate: { threshold: 0 },
    });
    connection.send("text", "Hello");
    const [frame] = await waitForFrames(received, 1);
    assert.equal(frame?.rsv, 0b100);
    assert.equal(inflate(frame.payload).toString(), "Hello");
    end(connection);
  });

  test("client_no_context_takeover in the answer makes it compress every message on its own", async (t) => {
    // the client didn't offer it; the server's answer asks for it. Random
    // base64 has no repeats of its own, so only a second copy can refer back.
    const text = randomBytes(1500).toString("base64");
    for (const [answer, sameSize] of [
      ["permessage-deflate", false],
      ["permessage-deflate; client_no_context_takeover", true],
    ] as const) {
      const fake = await fakeServer(t, accept(answer));
      const received = record(fake.server);
      const connection = await connect(fake.url, { perMessageDeflate: true });
      connection.send("text", text);
      connection.send("text", text);
      const [first, second] = await waitForFrames(received, 2);
      assert.ok(first && second);
      if (sameSize) {
        // each message starts from an empty window, so both come out the same
        assert.deepEqual(second.payload, first.payload);
        assert.equal(inflate(second.payload).toString(), text);
      } else {
        // the second refers back to the first
        assert.ok(second.payload.length < first.payload.length / 4);
      }
      end(connection);
    }
  });

  test("client_max_window_bits in the answer limits the window it compresses with", async (t) => {
    // the client offered client_max_window_bits without a value; the answer
    // gives 8, so its output must decode with a 256-byte window
    const fake = await fakeServer(
      t,
      accept("permessage-deflate; client_max_window_bits=8"),
    );
    const received = record(fake.server);
    const connection = await connect(fake.url, { perMessageDeflate: true });
    connection.send("text", FAR_REPEATS);
    connection.send("text", FAR_REPEATS);
    const frames = await waitForFrames(received, 2);
    assert.ok(frames.every((frame) => frame.rsv === 0b100));
    assert.deepEqual(
      (await strictInflate256(frames.map((frame) => frame.payload))).map(
        String,
      ),
      [FAR_REPEATS, FAR_REPEATS],
    );
    end(connection);

    // the check itself works: with the default 32 KiB window the same data
    // refers 600 bytes back and a 256-byte window can't follow it
    const wide = await fakeServer(t, accept("permessage-deflate"));
    const wideReceived = record(wide.server);
    const wideConnection = await connect(wide.url, { perMessageDeflate: true });
    wideConnection.send("text", FAR_REPEATS);
    const [wideFrame] = await waitForFrames(wideReceived, 1);
    await assert.rejects(
      strictInflate256([wideFrame!.payload]),
      /too far back/,
    );
    end(wideConnection);
  });

  test("maxMessageSize applies to compressed messages: a bomb closes with 1009", async (t) => {
    // 10 MiB of zeros compressed to about 10 KiB, sent with the 101
    const bomb = zlib
      .deflateRawSync(Buffer.alloc(10 * 1024 * 1024), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      })
      .subarray(0, -4);
    const header = Buffer.from([
      0xc2,
      126,
      bomb.length >> 8,
      bomb.length & 0xff,
    ]);
    const fake = await fakeServer(
      t,
      accept("permessage-deflate", Buffer.concat([header, bomb])),
    );
    const received = record(fake.server);
    await connect(fake.url, {
      perMessageDeflate: true,
      maxMessageSize: 64 * 1024,
    });
    const [close] = await waitForFrames(received, 1);
    assert.equal(close?.opcode, 0x8);
    assert.equal(close.payload.readUInt16BE(0), 1009);
  });

  test("closeTimeout applies: the socket is destroyed when the server never answers the close", async (t) => {
    const fake = await fakeServer(t, accept("permessage-deflate"));
    const connection = await connect(fake.url, {
      perMessageDeflate: true,
      closeTimeout: 50,
    });
    const started = Date.now();
    const closed = once(connection, "close");
    connection.close(1000);
    // the fake server never sends a close frame back
    const [code] = await withTimeout(closed, "the close event");
    assert.equal(code, 1006);
    assert.ok(Date.now() - started < 2000);
  });

  test("reads a compressed message sent with the 101", async (t) => {
    const fake = await fakeServer(
      t,
      accept(
        "permessage-deflate",
        // "Hello" compressed, RFC 7692 section 7.2.3.1
        Buffer.from("c107f248cdc9c90700", "hex"),
      ),
    );
    const connection = await connect(fake.url, { perMessageDeflate: true });
    assert.deepEqual(await nextMessage(connection), {
      type: "text",
      payload: "Hello",
    });
    end(connection);
  });

  test("accepts an answer that limits its window and context", async (t) => {
    const fake = await fakeServer(
      t,
      accept(
        "permessage-deflate; client_no_context_takeover; client_max_window_bits=9; " +
          "server_no_context_takeover; server_max_window_bits=10",
      ),
    );
    const connection = await connect(fake.url, {
      perMessageDeflate: { serverMaxWindowBits: 12 },
    });
    end(connection);
  });

  for (const [answer, options, reason] of [
    ["permessage-deflate", undefined, /did not ask for/],
    ["x-webkit-deflate-frame", true, /did not ask for/],
    ["", true, /empty/],
    ["permessage-deflate, permessage-deflate", true, /more than one/],
    ["permessage-deflate; foo", true, /foo/],
    [
      "permessage-deflate; server_max_window_bits=16",
      true,
      /server_max_window_bits/,
    ],
    [
      "permessage-deflate; client_max_window_bits",
      true,
      /client_max_window_bits/,
    ],
    [
      "permessage-deflate; client_no_context_takeover=1",
      true,
      /client_no_context_takeover/,
    ],
    [
      "permessage-deflate; server_no_context_takeover; server_no_context_takeover",
      true,
      /more than once/,
    ],
    [
      "permessage-deflate; server_max_window_bits=12",
      { serverMaxWindowBits: 10 },
      /server_max_window_bits/,
    ],
    [
      "permessage-deflate",
      { serverMaxWindowBits: 10 },
      /server_max_window_bits/,
    ],
    [
      "permessage-deflate",
      { serverNoContextTakeover: true },
      /server_no_context_takeover/,
    ],
    ["permessage-deflate; =", true, /Sec-WebSocket-Extensions/],
  ] as const) {
    test(`fails on the answer ${JSON.stringify(answer)} to ${JSON.stringify(options ?? "no offer")}`, async (t) => {
      const fake = await fakeServer(t, accept(answer));
      await assert.rejects(
        connect(fake.url, { perMessageDeflate: options }),
        reason,
      );
    });
  }
});
