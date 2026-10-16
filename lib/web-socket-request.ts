import { createHash } from "node:crypto";
import EventEmitter from "node:events";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { WebSocketConnection } from "./web-socket-connection.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WEBSOCKET_VERSION = "13";

// RFC 6455 4.2.1: the key is a base64-encoded 16-byte value, which is always
// 22 base64 characters followed by "==" padding.
const KEY_REGEX = /^[A-Za-z0-9+/]{22}==$/;

// A handshake check that failed, with the HTTP status to reply with.
export class HandshakeError extends Error {
  public status: 400 | 426;

  constructor(message: string, status: 400 | 426 = 400) {
    super(message);
    this.status = status;
  }
}

export class WebSocketRequest extends EventEmitter {
  private httpRequest: IncomingMessage;
  private socket: Socket;
  private websocketKey: string | undefined;

  constructor(request: IncomingMessage, socket: Socket) {
    super();
    this.httpRequest = request;
    this.socket = socket;
  }

  // Checks the opening handshake against RFC 6455 4.2.1.
  // Throws a HandshakeError if any check fails.
  public readRequest() {
    const req = this.httpRequest;

    if (req.method !== "GET") {
      throw new HandshakeError("GET is the only valid method");
    }

    if (
      req.httpVersionMajor < 1 ||
      (req.httpVersionMajor === 1 && req.httpVersionMinor < 1)
    ) {
      throw new HandshakeError("HTTP/1.1 or higher is required");
    }

    // Any path and query are allowed (RFC 6455 3), as long as the
    // request-target is in origin form.
    if (!req.url?.startsWith("/")) {
      throw new HandshakeError("Invalid resource path");
    }

    if (!req.headers["host"]) {
      throw new HandshakeError("Missing Host header");
    }

    if (!hasToken(req.headers["upgrade"], "websocket")) {
      throw new HandshakeError("Invalid value for Upgrade header");
    }

    if (!hasToken(req.headers["connection"], "upgrade")) {
      throw new HandshakeError("Invalid value for Connection header");
    }

    const key = req.headers["sec-websocket-key"];

    if (!key) {
      throw new HandshakeError("Missing Sec-WebSocket-Key header");
    }

    if (!KEY_REGEX.test(key)) {
      throw new HandshakeError("Invalid value for Sec-WebSocket-Key header");
    }

    const version = req.headers["sec-websocket-version"];

    if (!version) {
      throw new HandshakeError("Missing Sec-WebSocket-Version header");
    }

    // RFC 6455 4.4: an unsupported version gets 426 with the versions we support.
    if (version !== WEBSOCKET_VERSION) {
      throw new HandshakeError("Unsupported Sec-WebSocket-Version", 426);
    }

    // Only remember the key once every check has passed.
    this.websocketKey = key;
  }

  public acceptRequest() {
    if (!this.websocketKey) {
      throw new Error(
        "The request must pass readRequest before it can be accepted",
      );
    }

    this.socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${this.generateWebSocketAccept(this.websocketKey)}\r\n` +
        `\r\n`,
      "ascii",
    );

    const connection = new WebSocketConnection(this.socket);

    return connection;
  }

  // Replies with an HTTP error and closes the connection (RFC 6455 4.2.2).
  public rejectRequest(error: unknown) {
    const status = error instanceof HandshakeError ? error.status : 400;
    const body = error instanceof Error ? error.message : "Bad Request";

    let headers = `Connection: close\r\n` + `Content-Type: text/plain\r\n`;

    if (status === 426) {
      headers +=
        `Upgrade: websocket\r\n` +
        `Sec-WebSocket-Version: ${WEBSOCKET_VERSION}\r\n`;
    }

    this.socket.once("finish", () => this.socket.destroy());
    this.socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
        headers +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `\r\n` +
        body,
      "ascii",
    );
  }

  private generateWebSocketAccept(key: string) {
    return createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
  }
}

// Checks whether a comma-separated header value contains a token,
// ignoring case, e.g. "keep-alive, Upgrade" contains "upgrade".
function hasToken(header: string | undefined, token: string) {
  return (
    header?.split(",").some((value) => value.trim().toLowerCase() === token) ??
    false
  );
}
