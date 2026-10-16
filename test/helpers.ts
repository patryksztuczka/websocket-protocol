// Helpers shared by the server tests. Not a test file itself, so `pnpm test`
// doesn't run it.
import { once } from "node:events";
import http, { createServer, type Server } from "node:http";
import net from "node:net";

import { WebSocketClient } from "../lib/web-socket-client.ts";
import type { WebSocketConnection } from "../lib/web-socket-connection.ts";
import { WebSocketServer } from "../lib/web-socket-server.ts";

/** A valid Sec-WebSocket-Key, the sample from RFC 6455 section 1.3. */
const SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

/** Resolves with the port once the server listens on a free one. */
export async function listen(server: net.Server | Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

/**
 * Starts a WebSocket server on a free port. close() destroys every socket it
 * has, so a test that fails with a client still open doesn't keep the
 * process waiting.
 */
export async function startServer() {
  const httpServer = createServer();
  const wsServer = new WebSocketServer(httpServer);
  const sockets = new Set<net.Socket>();
  httpServer.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(httpServer);

  return {
    httpServer,
    wsServer,
    port,
    url: `ws://127.0.0.1:${port}`,
    close() {
      for (const socket of sockets) socket.destroy();
      httpServer.close();
    },
  };
}

/** Connects and resolves with the connection, or rejects with the failure reason. */
export function connect(url: string): Promise<WebSocketConnection> {
  return new Promise((resolve, reject) => {
    const client = new WebSocketClient();
    client.on("connect", resolve);
    client.on("connectionFailed", (reason: string) =>
      reject(new Error(reason)),
    );
    client.connect(url);
  });
}

/** Resolves with the payload of the next text message on the connection. */
export async function nextText(
  connection: WebSocketConnection,
): Promise<string> {
  const [message] = await once(connection, "message");
  return message.payload;
}

/**
 * Sends a valid opening handshake with plain `node:http` and resolves with the
 * answer when it isn't a 101, so tests can read the status, headers and body
 * of a rejection. Resolves with status 101 and no body when it is.
 */
export function handshake(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      agent: false,
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": SAMPLE_KEY,
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.alloc(0),
      });
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      // a body shorter than its Content-Length ends with an error, not "end"
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Opens a raw TCP connection and sends a valid opening handshake for `path`,
 * so a test can end or reset the connection while the server decides.
 */
export async function rawHandshake(
  port: number,
  path: string,
): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${SAMPLE_KEY}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`,
  );
  return socket;
}
