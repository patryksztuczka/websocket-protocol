import { createHash, randomBytes } from "node:crypto";
import EventEmitter from "node:events";
import http, { IncomingMessage, type ClientRequest } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { ConnectionOptions } from "node:tls";

import { WebSocketConnection } from "./web-socket-connection.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * TLS options for a `wss:` address, passed on to `https.request`. The address
 * itself sets the host and port, so options that pick the network target are
 * left out.
 */
export type WebSocketClientTlsOptions = Omit<
  ConnectionOptions,
  "host" | "port" | "path" | "socket" | "timeout"
>;

export interface WebSocketClientOptions {
  /** Used for `wss:` addresses only, for example `{ ca }` to trust a self-signed certificate. */
  tls?: WebSocketClientTlsOptions;
}

export class WebSocketClient extends EventEmitter {
  private req: ClientRequest | null = null;
  private websocketKey!: string;
  private socket: Socket | null = null;
  // the address being connected to; the connection keeps its path and query
  private target: URL | null = null;
  // set once "connect" or "connectionFailed" has been emitted, so only one of them is
  private settled = false;

  constructor() {
    super();
  }

  /**
   * Opens a connection to a `ws://host[:port]/path?query` or `wss://...`
   * address. Emits "connect" with a `WebSocketConnection`, which starts reading
   * messages by itself right after, or "connectionFailed" with the reason.
   * Throws for an invalid address or invalid TLS options, such as a `cert`
   * that can't be read or a `servername` that is an IP address.
   */
  public connect(url: string, options: WebSocketClientOptions = {}) {
    const target = new URL(url);

    if (target.protocol !== "ws:" && target.protocol !== "wss:") {
      throw new Error(
        `Invalid WebSocket address, expected ws: or wss: but got ${url}`,
      );
    }

    // fragments have no meaning in a WebSocket address (RFC 6455 section 3)
    if (target.hash !== "") {
      throw new Error("A WebSocket address must not contain a fragment (#)");
    }

    this.settled = false;
    this.socket = null;
    this.target = target;
    // a fresh random 16-byte key for every handshake (RFC 6455 section 4.1)
    this.websocketKey = randomBytes(16).toString("base64");

    // wss: runs the same handshake over TLS, on port 443 by default (RFC 6455 section 3)
    const secure = target.protocol === "wss:";

    const requestOptions: http.RequestOptions = {
      method: "GET",
      // URL keeps the brackets around an IPv6 address, http.request wants it without
      hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: target.port || (secure ? 443 : 80),
      // "/" when the path is empty, plus the query if there is one
      path: target.pathname + target.search,
      // a WebSocket connection gets its own socket, never one from a keep-alive pool
      agent: false,
      headers: {
        // URL leaves out the port when it is the default 80 for ws: or 443 for
        // wss:, as RFC 6455 section 4.1 asks
        host: target.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": this.websocketKey,
        "sec-websocket-version": "13",
      },
    };

    // the TLS options go first, so they can't replace the method, host, port,
    // path, agent or headers above; socketPath isn't a TLS option but would
    // send the connection to a local socket instead, so it is cleared too.
    // `lookup` still applies, so the caller can resolve the host name itself.
    // A TLS error such as an untrusted certificate comes in as a request error,
    // while invalid options such as a bad `cert` make https.request throw here
    this.req = secure
      ? https.request({
          ...options.tls,
          ...requestOptions,
          socketPath: undefined,
        })
      : http.request(requestOptions);

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

    this.succeedHandshake(response, head);
  }

  private failConnection(reason: string) {
    if (this.settled) return;
    this.settled = true;

    // _Fail the WebSocket Connection_: drop the network connection (RFC 6455 section 7.1.7)
    this.socket?.destroy();
    this.req?.destroy();
    this.emit("connectionFailed", reason);
  }

  private succeedHandshake(response: IncomingMessage, head: Buffer) {
    if (this.settled || !this.socket || !this.target) return;
    this.settled = true;

    const connection = new WebSocketConnection(
      this.socket,
      "client",
      {},
      {
        path: this.target.pathname,
        query: new URLSearchParams(this.target.search),
        headers: response.headers,
      },
    );

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
