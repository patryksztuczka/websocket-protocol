import { createHash, randomBytes } from "node:crypto";
import EventEmitter from "node:events";
import http, { IncomingMessage, type ClientRequest } from "node:http";
import type { Socket } from "node:net";

import { WebSocketConnection } from "./web-socket-connection.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocketClient extends EventEmitter {
  private req: ClientRequest | null = null;
  private websocketKey: string;
  private socket: Socket;

  constructor() {
    super();
  }

  public connect() {
    this.websocketKey = randomBytes(16).toString("base64");
    this.req = http.request({
      method: "GET",
      hostname: "127.0.0.1",
      port: 8080,
      path: "/",
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": this.websocketKey,
        "sec-websocket-version": "13",
      },
    });

    this.req.end();

    this.req.on("upgrade", (res, socket) =>
      this.handleRequestUpgrade(res, socket),
    );

    this.req.on("error", this.handleRequestError);
  }

  private handleRequestUpgrade(response: IncomingMessage, socket: Socket) {
    this.req?.removeListener("error", this.handleRequestError);
    this.socket = socket;
    this.validateHandshake(response);
  }

  private handleRequestError() {}

  private validateHandshake(response: IncomingMessage) {
    if (response.statusCode !== 101) {
      this.failHandshake("Received non 101 status code");
      return;
    }

    if (response.headers["upgrade"] !== "websocket") {
      this.failHandshake("Invalid Upgrade header");
      return;
    }

    if (response.headers["connection"] !== "Upgrade") {
      this.failHandshake("Invalid Connection header");
      return;
    }

    if (!response.headers["sec-websocket-accept"]) {
      this.failHandshake("Missing sec-websocket-accept header");
      return;
    }

    const expectedKey = createHash("sha1")
      .update(this.websocketKey + WEBSOCKET_GUID)
      .digest("base64");

    if (response.headers["sec-websocket-accept"] !== expectedKey) {
      this.failHandshake("Invalid sec-websocket-accept header");
      return;
    }

    this.succeedHandshake();
  }

  private failHandshake(errorMessage: string) {
    // handle close/end/destroy socket
    this.emit("connectionFailed", errorMessage);
  }

  private succeedHandshake() {
    const connection = new WebSocketConnection(this.socket);
    this.emit("connect", connection);
  }

  public emit(eventName: "connect" | "connectionFailed", ...args: any[]) {
    return super.emit(eventName, ...args);
  }

  public on(
    eventName: "connect" | "connectionFailed",
    listener: (...args: any[]) => void,
  ) {
    return super.on(eventName, listener);
  }
}
