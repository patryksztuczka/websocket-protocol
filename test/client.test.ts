// Client tests. Run with `pnpm test`. Each test starts its own server on a free
// port, so nothing else needs to be running.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type OutgoingHttpHeaders, type Server } from "node:http";
import https from "node:https";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import tls from "node:tls";

import {
  WebSocketClient,
  type WebSocketClientOptions,
} from "../lib/web-socket-client.ts";
import type { WebSocketConnection } from "../lib/web-socket-connection.ts";
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

/** Resolves with the port once the server listens on a free one. */
async function listen(server: net.Server | Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

/** Connects and resolves with the connection, or rejects with the failure reason. */
function connect(
  url: string,
  options?: WebSocketClientOptions,
): Promise<WebSocketConnection> {
  return new Promise((resolve, reject) => {
    const client = new WebSocketClient();
    client.on("connect", resolve);
    client.on("connectionFailed", (reason: string) =>
      reject(new Error(reason)),
    );
    client.connect(url, options);
  });
}

/** Resolves with the next text or binary message on the connection. */
function nextMessage(connection: WebSocketConnection): Promise<Message> {
  return new Promise((resolve) => {
    connection.once("message", resolve);
    connection.once("binaryMessage", resolve);
  });
}

/** Closes the connection with the closing handshake. */
function end(connection: WebSocketConnection) {
  connection.close();
}

/**
 * A raw TCP server that reads the client's handshake request and answers with
 * whatever `respond` returns, so tests can send answers the real server never would.
 * With `secure` it speaks TLS with the fixture certificate and gives a wss: address.
 */
async function fakeServer(
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
    httpServer.close();
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

  test("a wrong Sec-WebSocket-Accept emits connectionFailed and drops the connection", async () => {
    const fake = await fakeServer(
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
    fake.server.close();
  });

  test("a response other than 101 emits connectionFailed", async () => {
    const fake = await fakeServer(
      () => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
    );

    await assert.rejects(connect(fake.url), /status 404/);
    fake.server.close();
  });

  test("accepts Upgrade and Connection values in any case and reads a frame sent with the 101", async () => {
    const fake = await fakeServer((key) =>
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
    fake.server.close();
  });

  test("sends the path, query and Host with a non-default port", async () => {
    let request = "";
    const fake = await fakeServer(() => "HTTP/1.1 400 Bad Request\r\n\r\n");
    fake.server.on("connection", (socket: net.Socket) =>
      socket.on("data", (data) => (request += data.toString("latin1"))),
    );
    const port = (fake.server.address() as net.AddressInfo).port;

    await assert.rejects(connect(`ws://127.0.0.1:${port}/chat?room=1`));
    assert.match(request, /^GET \/chat\?room=1 HTTP\/1\.1\r\n/);
    assert.match(request, new RegExp(`\r\nhost: 127.0.0.1:${port}\r\n`, "i"));
    assert.match(request, /\r\nsec-websocket-version: 13\r\n/i);
    fake.server.close();
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
    httpsServer.close();
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

  test("reads a frame sent in the same TLS record as the 101", async () => {
    const fake = await fakeServer(
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
    fake.server.close();
  });
});
