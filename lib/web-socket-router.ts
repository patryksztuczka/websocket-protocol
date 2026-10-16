// Routing above the protocol: connections by path during the opening
// handshake, and JSON messages by type once the connection is open. Nothing
// here touches frames, masking or the closing handshake; it only uses the
// server's "request" event and a connection's "message" event, send() and
// close().
import type {
  TextMessage,
  WebSocketConnection,
} from "./web-socket-connection.ts";
import type { WebSocketRequest } from "./web-socket-request.ts";
import type { WebSocketServer } from "./web-socket-server.ts";

/** The values of a pattern's `:name` segments, e.g. { id: "42" }. */
export type RouteParams = Record<string, string>;

/** What a route handler learns about the connection besides the connection itself. */
export interface RouteContext {
  /**
   * The values of the pattern's `:name` segments, percent-decoded: "/rooms/:id"
   * and "/rooms/42" give { id: "42" }.
   */
  params: RouteParams;
  /** The query of the address, e.g. `query.get("token")` for "?token=abc". */
  query: URLSearchParams;
  /** The accepted request, with its path and headers. */
  request: WebSocketRequest;
}

export type RouteHandler = (
  connection: WebSocketConnection,
  context: RouteContext,
) => void;

interface Route {
  // the pattern split at "/", e.g. ["", "rooms", ":id"]
  segments: string[];
  handler: RouteHandler;
}

/**
 * Routes connections by path. It answers the server's "request" event: the
 * first route whose pattern matches the path accepts the request and gets the
 * open connection, and a path no route matches gets 404, so it never gets a
 * 101 and no WebSocket connection opens (RFC 6455 4.2.2).
 *
 * A "request" listener added before the router runs first and can reject a
 * request, for example to check a token; the router leaves requests that are
 * already answered alone. "connect" still fires for every routed connection,
 * before its route handler runs.
 */
export class WebSocketRouter {
  private routes: Route[] = [];

  constructor(server: WebSocketServer) {
    server.on("request", (request) => this.handleRequest(request));
  }

  /**
   * Adds a route. A pattern is a path whose segments are either literal,
   * matched exactly and case-sensitively, or `:name`, which matches any one
   * non-empty segment and puts its value in `params.name`. "/rooms/:id"
   * matches "/rooms/42" but not "/rooms", "/rooms/" or "/rooms/42/chat".
   * Routes are tried in the order they were added.
   */
  public route(pattern: string, handler: RouteHandler) {
    if (!pattern.startsWith("/")) {
      throw new Error(`A route pattern must start with /, got "${pattern}"`);
    }
    this.routes.push({ segments: pattern.split("/"), handler });
    return this;
  }

  private handleRequest(request: WebSocketRequest) {
    // another "request" listener has already accepted or rejected it
    if (request.answered) return;

    for (const route of this.routes) {
      const params = matchPath(route.segments, request.path);
      if (!params) continue;

      const connection = request.accept();
      route.handler(connection, { params, query: request.query, request });
      // start reading only once the handler has added its listeners, so it
      // can't miss the first message
      connection.addSocketEventListeners();
      return;
    }

    request.reject(404);
  }
}

/**
 * Matches a path against a pattern split at "/". Returns the params, or null
 * if the path doesn't match.
 */
function matchPath(segments: string[], path: string): RouteParams | null {
  const parts = path.split("/");
  if (parts.length !== segments.length) return null;

  const params: RouteParams = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const part = parts[i] ?? "";

    if (!segment.startsWith(":")) {
      if (segment !== part) return null;
      continue;
    }

    if (part === "") return null;
    try {
      params[segment.slice(1)] = decodeURIComponent(part);
    } catch {
      // not valid percent-encoding, so not a value this route can match
      return null;
    }
  }
  return params;
}

/**
 * Handles one type of message. `data` is the message's `data` field as parsed
 * from JSON, so check its shape before using it. `type` is the message's type.
 */
export type MessageHandler = (data: unknown, type: string) => void;

/**
 * Routes a connection's text messages by type. Every text message must be a
 * JSON object with a string `type`, such as `{ "type": "join", "data": ... }`.
 * The handler for that type gets `data`; a type with no handler goes to the
 * fallback, or is ignored when there is none.
 *
 * A text message that isn't such an object closes the connection with 1007,
 * the code for data that doesn't fit the message's type (RFC 6455 section
 * 7.4.1). Binary messages aren't routed and still arrive through the
 * connection's "binaryMessage" event.
 */
export class MessageRouter {
  private connection: WebSocketConnection;
  private handlers = new Map<string, MessageHandler>();
  private fallbackHandler: MessageHandler | undefined;

  constructor(connection: WebSocketConnection) {
    this.connection = connection;
    connection.on("message", (message) => this.handleMessage(message));
  }

  /** Sets the handler for messages of `type`, replacing any earlier one. */
  public on(type: string, handler: MessageHandler) {
    this.handlers.set(type, handler);
    return this;
  }

  /** Sets the handler for messages whose type has no handler of its own. */
  public fallback(handler: MessageHandler) {
    this.fallbackHandler = handler;
    return this;
  }

  /** Sends `{ type, data }` as a JSON text message. */
  public send(type: string, data?: unknown) {
    this.connection.send("text", JSON.stringify({ type, data }));
  }

  private handleMessage(message: TextMessage) {
    // after a close, such as the 1007 below, later messages are dropped
    if (this.connection.readyState !== "open") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload);
    } catch {
      this.connection.close(1007, "Message is not JSON");
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("type" in parsed) ||
      typeof parsed.type !== "string"
    ) {
      this.connection.close(1007, "Message has no type");
      return;
    }

    const data = "data" in parsed ? parsed.data : undefined;
    const handler = this.handlers.get(parsed.type) ?? this.fallbackHandler;
    handler?.(data, parsed.type);
  }
}
