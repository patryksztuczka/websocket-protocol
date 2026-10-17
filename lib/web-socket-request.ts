import { createHash } from "node:crypto";
import EventEmitter from "node:events";
import {
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { Socket } from "node:net";

import {
  PerMessageDeflate,
  formatPerMessageDeflate,
  negotiatePerMessageDeflate,
  parseExtensions,
  resolvePerMessageDeflateOptions,
  type PerMessageDeflateParams,
  type ResolvedPerMessageDeflateOptions,
} from "./permessage-deflate.ts";
import {
  WebSocketConnection,
  type WebSocketConnectionOptions,
} from "./web-socket-connection.ts";

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

export interface WebSocketRequestEvents {
  /** The request was accepted and the connection is open. */
  accept: [connection: WebSocketConnection];
  /**
   * The client closed the TCP connection before the request was answered, so
   * there is no one left to answer. Never emitted once it has been answered.
   */
  close: [];
}

/**
 * A client's opening handshake. The server checks it with readRequest(), then
 * it is answered with accept() or reject(), exactly once. If the client goes
 * away first, the request emits "close" and both become no-ops.
 */
export class WebSocketRequest extends EventEmitter<WebSocketRequestEvents> {
  /** The path the client asked for, without the query, e.g. "/rooms/42". */
  public readonly path: string;
  /** The query of the address, e.g. `query.get("token")` for "?token=abc". */
  public readonly query: URLSearchParams;
  /** The handshake's HTTP headers. Names are lowercase. */
  public readonly headers: IncomingHttpHeaders;
  private httpRequest: IncomingMessage;
  private socket: Socket;
  private websocketKey: string | undefined;
  private connectionOptions: WebSocketConnectionOptions;
  private isAnswered = false;
  // set once the client has ended or closed the TCP connection before an answer
  private clientGone = false;
  // the server's compression settings, or undefined when compression is off
  private deflateOptions: ResolvedPerMessageDeflateOptions | undefined;
  // the agreed permessage-deflate parameters, if an offer was accepted
  private deflateParams: PerMessageDeflateParams | undefined;

  /**
   * `deflateOptions` is `connectionOptions.perMessageDeflate` resolved; the
   * server passes it in so it is only resolved once.
   */
  constructor(
    request: IncomingMessage,
    socket: Socket,
    connectionOptions: WebSocketConnectionOptions = {},
    deflateOptions = resolvePerMessageDeflateOptions(
      connectionOptions.perMessageDeflate,
    ),
  ) {
    super();
    this.httpRequest = request;
    this.socket = socket;
    this.connectionOptions = connectionOptions;
    this.deflateOptions = deflateOptions;

    // split the request-target by hand: URL would read "//host/path" as a
    // host and change the path the client sent
    const url = request.url ?? "/";
    const queryStart = url.indexOf("?");
    this.path = queryStart === -1 ? url : url.slice(0, queryStart);
    this.query = new URLSearchParams(
      queryStart === -1 ? "" : url.slice(queryStart + 1),
    );
    this.headers = request.headers;

    // Node's HTTP server stops listening to the socket once it hands it over
    // for an upgrade, so watch it until the request is answered. Without an
    // "error" listener a client that resets the connection would crash the
    // process; "close" follows the error.
    this.socket.on("error", () => {});
    this.socket.on("end", this.handleSocketEnd);
    this.socket.on("close", this.handleSocketClose);
  }

  /** Whether the request has been accepted or rejected. */
  public get answered() {
    return this.isAnswered;
  }

  /**
   * Whether the client ended or closed the TCP connection before the request
   * was answered. accept() and reject() do nothing once this is true.
   */
  public get closed() {
    return this.clientGone;
  }

  // The client ended its side before an answer. The upgrade socket allows
  // half-open connections, so end ours too or nothing ever closes it.
  private handleSocketEnd = () => {
    this.clientGone = true;
    this.socket.end();
  };

  private handleSocketClose = () => {
    this.clientGone = true;
    this.emit("close");
  };

  // Once the request is answered, the connection, or the rejection, takes
  // care of the socket.
  private stopWatchingSocket() {
    this.socket.off("end", this.handleSocketEnd);
    this.socket.off("close", this.handleSocketClose);
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

    const deflateParams = this.negotiateExtensions();

    // Only remember the key once every check has passed.
    this.websocketKey = key;
    this.deflateParams = deflateParams;
  }

  /**
   * Picks the permessage-deflate offer to accept from Sec-WebSocket-Extensions
   * (RFC 7692 section 5), when compression is turned on. Other extensions
   * aren't supported and are left out of the answer, which declines them
   * (RFC 6455 section 9.1).
   */
  private negotiateExtensions(): PerMessageDeflateParams | undefined {
    const header = this.httpRequest.headers["sec-websocket-extensions"];
    if (!this.deflateOptions || header === undefined) return undefined;

    try {
      return negotiatePerMessageDeflate(
        parseExtensions(header),
        this.deflateOptions,
      );
    } catch (error) {
      throw new HandshakeError(
        error instanceof Error
          ? error.message
          : "Invalid Sec-WebSocket-Extensions header",
      );
    }
  }

  /**
   * Answers with 101 Switching Protocols (RFC 6455 4.2.2), emits "accept" and
   * returns the open connection. Returns undefined, and opens nothing, if the
   * client has already gone (see `closed`). Throws if the request has already
   * been answered.
   *
   * If an "accept" listener throws, such as one of the server's "connect"
   * listeners, the connection is closed with 1011, still read, and accept()
   * rethrows the error.
   */
  public accept(): WebSocketConnection | undefined {
    if (!this.websocketKey) {
      throw new Error(
        "The request must pass readRequest before it can be accepted",
      );
    }
    this.assertUnanswered();
    // also covers a socket that closed before its "close" event has run. This
    // comes before anything is set up, so a client that has gone never gets
    // a connection or its compression.
    if (this.clientGone || !this.socket.writable) return undefined;
    this.isAnswered = true;
    this.stopWatchingSocket();

    // the accepted offer's agreed parameters (RFC 7692 section 5)
    const extensions = this.deflateParams
      ? `Sec-WebSocket-Extensions: ${formatPerMessageDeflate(this.deflateParams)}\r\n`
      : "";

    this.socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${this.generateWebSocketAccept(this.websocketKey)}\r\n` +
        extensions +
        `\r\n`,
      "ascii",
    );

    // compresses and decompresses the connection's messages with the agreed
    // parameters; an offer is only accepted when compression is on
    const compression =
      this.deflateParams && this.deflateOptions
        ? new PerMessageDeflate(
            this.deflateParams,
            "server",
            this.deflateOptions.threshold,
          )
        : undefined;

    const connection = new WebSocketConnection(
      this.socket,
      "server",
      { path: this.path, query: this.query, headers: this.headers },
      this.connectionOptions,
      compression,
    );

    try {
      this.emit("accept", connection);
    } catch (error) {
      // a listener, such as one of the server's "connect" listeners, threw
      // before the caller got the connection. Close it with 1011 (RFC 6455
      // section 7.4.1) and read it, so the peer's close frame is answered
      // and the connection doesn't hang, then report the error. close()
      // goes through the connection's send queue, so the close frame waits
      // for any message the listener sent that is still being compressed.
      connection.close(1011);
      connection.addSocketEventListeners();
      throw error;
    }
    return connection;
  }

  /**
   * Refuses the connection before it opens: answers with `status`, which must
   * be 4xx or 5xx, and `reason` as a plain-text body, then closes the TCP
   * connection (RFC 6455 4.2.2). `reason` defaults to the status text, such
   * as "Not Found". Does nothing if the client has already gone (see
   * `closed`). Throws if the request has already been answered.
   */
  public reject(status: number, reason?: string) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`Status ${status} can't reject a request`);
    }
    this.assertUnanswered();
    if (this.clientGone || !this.socket.writable) return;
    this.isAnswered = true;
    this.stopWatchingSocket();

    const body = reason ?? STATUS_CODES[status] ?? "Error";
    let headers =
      `Connection: close\r\n` + `Content-Type: text/plain; charset=utf-8\r\n`;

    if (status === 426) {
      headers +=
        `Upgrade: websocket\r\n` +
        `Sec-WebSocket-Version: ${WEBSOCKET_VERSION}\r\n`;
    }

    this.socket.once("finish", () => this.socket.destroy());
    // the reason can be any text, so it is sent as UTF-8, which is also what
    // Content-Length counts
    this.socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n` +
        headers +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `\r\n` +
        body,
      "utf8",
    );
  }

  private assertUnanswered() {
    if (this.isAnswered) {
      throw new Error("The request has already been answered");
    }
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
