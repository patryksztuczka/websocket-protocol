// Helpers shared by the server tests. Not a test file itself, so `pnpm test`
// doesn't run it.
import { once } from "node:events";
import http, { type Server } from "node:http";
import type net from "node:net";

import { WebSocketClient } from "../lib/web-socket-client.ts";
import type { WebSocketConnection } from "../lib/web-socket-connection.ts";

/** Resolves with the port once the server listens on a free one. */
export async function listen(server: net.Server | Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
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
  body: string;
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
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}
