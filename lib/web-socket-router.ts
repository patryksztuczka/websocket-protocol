// Routing above the protocol: connections by path during the opening
// handshake, and JSON messages by type once the connection is open. Nothing
// here touches frames, masking or the closing handshake; it only uses a
// request's accept() and reject(), and a connection's "message" event, send()
// and close().
import type {
  TextMessage,
  WebSocketConnection,
} from "./web-socket-connection.ts";
import type { WebSocketRequest } from "./web-socket-request.ts";

/**
 * The values of a pattern's `:name` segments, e.g. { id: "42" }. The object
 * has no prototype, so any name, even "__proto__", is a plain key.
 */
export type RouteParams = Record<string, string>;

/** What a route handler learns about the connection besides the connection itself. */
export interface RouteContext {
  /**
   * The values of the pattern's `:name` segments, percent-decoded: "/rooms/:id"
   * and "/rooms/42" give { id: "42" }. "%2F" decodes to "/", so a param can
   * hold a slash.
   */
  params: RouteParams;
  /** The query of the address, e.g. `query.get("token")` for "?token=abc". */
  query: URLSearchParams;
  /** The accepted request, with its path and headers. */
  request: WebSocketRequest;
}

/**
 * Sets up a routed connection. It runs right after the 101, and the router
 * starts reading the connection as soon as it returns, so add listeners
 * before any `await`: messages that arrive while an async handler waits are
 * lost. Do async work, such as an auth check, before calling handle().
 */
export type RouteHandler = (
  connection: WebSocketConnection,
  context: RouteContext,
) => void;

// one segment of a pattern: matched exactly, or captured under a name
type Segment = { literal: string } | { param: string };

interface Route {
  segments: Segment[];
  handler: RouteHandler;
}

/**
 * Routes connections by path. The app passes each request to handle(), from
 * its own "request" listener, after any checks of its own:
 *
 * ```ts
 * server.on("request", async (request) => {
 *   if (!(await authorised(request))) return request.reject(401);
 *   router.handle(request);
 * });
 * ```
 *
 * The first route whose pattern matches the path accepts the request and
 * gets the open connection. A path no route matches gets 404, so it never
 * gets a 101 and no WebSocket connection opens (RFC 6455 4.2.2).
 */
export class WebSocketRouter {
  private routes: Route[] = [];

  /**
   * Adds a route. A pattern is a path whose segments are either literal,
   * matched exactly and case-sensitively, or `:name`, which matches any one
   * non-empty segment and puts its value in `params.name`. Both sides are
   * compared after percent-decoding, so "/caf%C3%A9" matches "/café".
   * "/rooms/:id" matches "/rooms/42" but not "/rooms", "/rooms/" or
   * "/rooms/42/chat". Routes are tried in the order they were added.
   *
   * Throws if the pattern doesn't start with "/", has a `:` without a name,
   * uses a name twice or isn't valid percent-encoding.
   */
  public route(pattern: string, handler: RouteHandler) {
    if (!pattern.startsWith("/")) {
      throw new Error(`A route pattern must start with /, got "${pattern}"`);
    }

    const names = new Set<string>();
    const segments = pattern.split("/").map((segment): Segment => {
      if (!segment.startsWith(":")) {
        const literal = decodeSegment(segment);
        if (literal === null) {
          throw new Error(`Invalid percent-encoding in "${pattern}"`);
        }
        return { literal };
      }

      const param = segment.slice(1);
      if (param === "") {
        throw new Error(`Each : in "${pattern}" needs a name`);
      }
      if (names.has(param)) {
        throw new Error(`"${pattern}" uses :${param} more than once`);
      }
      names.add(param);
      return { param };
    });

    this.routes.push({ segments, handler });
    return this;
  }

  /**
   * Answers a request: accepts it for the first matching route and calls that
   * route's handler, or rejects it with 404. Does nothing if the request has
   * already been answered or its client has gone.
   *
   * If the handler throws, its connection is closed with 1011 (RFC 6455
   * section 7.4.1) and handle() rethrows the error.
   */
  public handle(request: WebSocketRequest) {
    if (request.answered || request.closed) return;

    // decode each segment on its own, so "%2F" stays inside its segment
    const parts = request.path.split("/").map(decodeSegment);

    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;

      const connection = request.accept();
      // the client went away just now
      if (!connection) return;

      try {
        route.handler(connection, { params, query: request.query, request });
      } catch (error) {
        connection.close(1011);
        throw error;
      } finally {
        // whatever the handler did, read the connection, so a close frame
        // is answered and the connection doesn't hang
        connection.addSocketEventListeners();
      }
      return;
    }

    request.reject(404);
  }
}

/** Percent-decodes one path segment, or returns null if it can't be decoded. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Matches a path's decoded segments against a pattern's. Returns the params,
 * or null if the path doesn't match. A segment that couldn't be decoded
 * matches nothing.
 */
function matchSegments(
  segments: Segment[],
  parts: (string | null)[],
): RouteParams | null {
  if (parts.length !== segments.length) return null;

  const params: RouteParams = Object.create(null);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (segment === undefined || part === undefined || part === null) {
      return null;
    }

    if ("literal" in segment) {
      if (segment.literal !== part) return null;
    } else {
      if (part === "") return null;
      params[segment.param] = part;
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
 *
 * Errors thrown by handlers aren't caught. They come out of the connection's
 * "message" event like an error in any other listener, and stop the process
 * unless something handles uncaught exceptions.
 */
export class MessageRouter {
  private connection: WebSocketConnection;
  private handlers = new Map<string, MessageHandler>();
  private fallbackHandler: MessageHandler | undefined;

  constructor(connection: WebSocketConnection) {
    this.connection = connection;
    connection.on("message", (message) => this.handleMessage(message));
  }

  /**
   * Sets the handler for messages of `type`. Unlike an event listener, each
   * type has one handler, so this throws if `type` already has one.
   */
  public on(type: string, handler: MessageHandler) {
    if (this.handlers.has(type)) {
      throw new Error(`Message type "${type}" already has a handler`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  /**
   * Sets the handler for messages whose type has no handler of its own.
   * Throws if the fallback already has a handler.
   */
  public fallback(handler: MessageHandler) {
    if (this.fallbackHandler) {
      throw new Error("The fallback already has a handler");
    }
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
