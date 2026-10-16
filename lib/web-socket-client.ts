import { createHash, randomBytes } from "node:crypto";
import EventEmitter from "node:events";
import http, { IncomingMessage, type ClientRequest } from "node:http";
import type { Socket } from "node:net";

import { WebSocketConnection } from "./web-socket-connection.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocketClient extends EventEmitter {
  private req: ClientRequest | null = null;
  private websocketKey!: string;
  private socket: Socket | null = null;
  // set once "connect" or "connectionFailed" has been emitted, so only one of them is
  private settled = false;

  constructor() {
    super();
  }

  /**
   * Opens a connection to a `ws://host[:port]/path?query` address. Emits
   * "connect" with a `WebSocketConnection`, which starts reading messages by
   * itself right after, or "connectionFailed" with the reason.
   */
  public connect(url: string) {
    const target = new URL(url);

    if (target.protocol === "wss:") {
      throw new Error("wss: addresses are not supported yet, use ws:");
    }

    if (target.protocol !== "ws:") {
      throw new Error(`Invalid WebSocket address, expected ws: but got ${url}`);
    }

    // fragments have no meaning in a WebSocket address (RFC 6455 section 3)
    if (target.hash !== "") {
      throw new Error("A WebSocket address must not contain a fragment (#)");
    }

    this.settled = false;
    this.socket = null;
    // a fresh random 16-byte key for every handshake (RFC 6455 section 4.1)
    this.websocketKey = randomBytes(16).toString("base64");

    this.req = http.request({
      method: "GET",
      // URL keeps the brackets around an IPv6 address, http.request wants it without
      hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: target.port || 80,
      // "/" when the path is empty, plus the query if there is one
      path: target.pathname + target.search,
      // a WebSocket connection gets its own socket, never one from a keep-alive pool
      agent: false,
      headers: {
        // URL leaves out the port when it is the default 80, as RFC 6455 section 4.1 asks
        host: target.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": this.websocketKey,
        "sec-websocket-version": "13",
      },
    });

    this.req.on("upgrade", (res, socket, head) =>
      this.handleRequestUpgrade(res, socket, head),
    );
    // any answer other than a protocol switch comes in as a plain response
    this.req.on("response", (res) => this.handleRequestResponse(res));
    this.req.on("error", (err) => this.handleRequestError(err));

    this.req.end();
  }

  private handleRequestUpgrade(
    response: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) {
    this.socket = socket;
    this.validateHandshake(response, head);
  }

  private handleRequestResponse(response: IncomingMessage) {
    // Node only reports a 101 as an upgrade when it has both an Upgrade header
    // and "upgrade" in Connection, otherwise it lands here
    this.failConnection(
      response.statusCode === 101
        ? "Missing Upgrade header or Connection header without upgrade"
        : `Server did not switch protocols, got status ${response.statusCode}`,
    );
  }

  private handleRequestError(err: Error) {
    this.failConnection(`Request failed: ${err.message}`);
  }

  // RFC 6455 section 4.1 lists what the client must check in the server's answer
  private validateHandshake(response: IncomingMessage, head: Buffer) {
    if (response.statusCode !== 101) {
      this.failConnection("Received non 101 status code");
      return;
    }

    // the value is case-insensitive
    if (response.headers["upgrade"]?.toLowerCase() !== "websocket") {
      this.failConnection("Invalid Upgrade header");
      return;
    }

    // a comma-separated list of tokens, one of them "Upgrade" in any case
    const connectionTokens = (response.headers["connection"] ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase());

    if (!connectionTokens.includes("upgrade")) {
      this.failConnection("Invalid Connection header");
      return;
    }

    if (!response.headers["sec-websocket-accept"]) {
      this.failConnection("Missing sec-websocket-accept header");
      return;
    }

    const expectedKey = createHash("sha1")
      .update(this.websocketKey + WEBSOCKET_GUID)
      .digest("base64");

    if (response.headers["sec-websocket-accept"] !== expectedKey) {
      this.failConnection("Invalid sec-websocket-accept header");
      return;
    }

    // the client asks for no extensions and no subprotocol, so the server must not pick any
    if (response.headers["sec-websocket-extensions"] !== undefined) {
      this.failConnection(
        "Server chose an extension the client did not ask for",
      );
      return;
    }

    if (response.headers["sec-websocket-protocol"] !== undefined) {
      this.failConnection(
        "Server chose a subprotocol the client did not ask for",
      );
      return;
    }

    this.succeedHandshake(head);
  }

  private failConnection(reason: string) {
    if (this.settled) return;
    this.settled = true;

    // _Fail the WebSocket Connection_: drop the network connection (RFC 6455 section 7.1.7)
    this.socket?.destroy();
    this.req?.destroy();
    this.emit("connectionFailed", reason);
  }

  private succeedHandshake(head: Buffer) {
    if (this.settled || !this.socket) return;
    this.settled = true;

    const connection = new WebSocketConnection(this.socket, "client");

    // frames the server sent right after its answer can arrive in the same
    // packet; put them back so the connection reads them before anything else
    if (head.length > 0) this.socket.unshift(head);

    this.emit("connect", connection);

    // start reading on the next turn of the event loop, not right away, so code
    // that adds its message listeners after awaiting "connect" still gets the
    // first message; until then the socket keeps incoming data buffered
    setImmediate(() => connection.addSocketEventListeners());
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
