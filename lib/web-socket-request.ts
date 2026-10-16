import { createHash } from "node:crypto";
import EventEmitter from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import {
  WebSocketConnection,
  type WebSocketConnectionOptions,
} from "./web-socket-connection.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocketRequest extends EventEmitter {
  private httpRequest: IncomingMessage;
  private socket: Socket;
  private websocketKey: string | undefined;
  private connectionOptions: WebSocketConnectionOptions;

  constructor(
    request: IncomingMessage,
    socket: Socket,
    connectionOptions: WebSocketConnectionOptions = {},
  ) {
    super();
    this.httpRequest = request;
    this.socket = socket;
    this.connectionOptions = connectionOptions;
  }

  public readRequest() {
    const pathRegex = /^\/(\w+(\/\w+)*)?$/;

    const req = this.httpRequest;

    if (req.method !== "GET") {
      throw new Error("GET is the only valid method");
    }

    if (!req.url || !pathRegex.test(req.url)) {
      throw new Error("Invalid resource path");
    }

    if (!req.headers["host"]) {
      throw new Error("Missing Host header");
    }

    this.websocketKey = req.headers["sec-websocket-key"];

    if (!this.websocketKey) {
      throw new Error("Missing Sec-WebSocket-Key header");
    }

    if (req.headers["upgrade"]?.toLowerCase() !== "websocket") {
      throw new Error("Invalid value for Upgrade header");
    }

    if (req.headers["connection"]?.toLowerCase() !== "upgrade") {
      throw new Error("Invalid value for Connection header");
    }

    if (req.headers["sec-websocket-version"] !== "13") {
      throw new Error("Invalid value for Sec-WebSocket-Version header");
    }
  }

  public acceptRequest() {
    if (!this.websocketKey) {
      // TODO: reject the handshake with an HTTP error response (#14)
      return;
    }

    this.socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${this.generateWebSocketAccept(this.websocketKey)}\r\n` +
        `\r\n`,
      "ascii",
    );

    const connection = new WebSocketConnection(
      this.socket,
      "server",
      this.connectionOptions,
    );

    return connection;
  }

  private generateWebSocketAccept(key: string) {
    return createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
  }
}
