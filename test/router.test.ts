// Tests for WebSocketRouter (connections by path) and MessageRouter (JSON
// messages by type). Each suite starts its own server on a free port and
// talks to it with the real client.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";

import type { WebSocketConnection } from "../lib/web-socket-connection.ts";
import type { WebSocketRequest } from "../lib/web-socket-request.ts";
import {
  MessageRouter,
  WebSocketRouter,
  type RouteContext,
  type RouteParams,
} from "../lib/web-socket-router.ts";
import {
  connect,
  handshake,
  nextText,
  rawHandshake,
  startServer,
} from "./helpers.ts";

type Server = Awaited<ReturnType<typeof startServer>>;

type Routed = {
  name: string;
  connection: WebSocketConnection;
  context: RouteContext;
};

/** Params as the router builds them: an object without a prototype. */
function params(values: Record<string, string>): RouteParams {
  return Object.assign(Object.create(null), values);
}

describe("WebSocketRouter", () => {
  let server: Server;
  let router: WebSocketRouter;
  // every handler call, in order
  const routed: Routed[] = [];
  // every "connect" event, with how many handlers had run by then
  const connected: { connection: WebSocketConnection; handlers: number }[] = [];

  before(async () => {
    server = await startServer();
    server.wsServer.on("connect", (connection) =>
      connected.push({ connection, handlers: routed.length }),
    );

    const record = (name: string) => {
      return (connection: WebSocketConnection, context: RouteContext) => {
        routed.push({ name, connection, context });
      };
    };

    router = new WebSocketRouter()
      .route("/rooms/lobby", record("lobby"))
      .route("/rooms/:id", record("room"))
      .route("/files/:folder/:name", record("file"))
      .route("/café", record("café"))
      // a pattern written percent-encoded: "na%C3%AFve" is "naïve"
      .route("/na%C3%AFve", record("naïve"))
      .route("/proto/:__proto__", record("proto"))
      .route("/", record("root"));

    server.wsServer.on("request", (request) => router.handle(request));
  });

  after(() => {
    server.close();
  });

  /** Connects, waits for the route handler and returns its call. */
  async function open(path: string) {
    const count = routed.length;
    const client = await connect(server.url + path);
    const call = routed[count];
    assert.ok(call, `no handler ran for ${path}`);
    return { client, ...call };
  }

  test("an unknown path gets 404 and never a 101", async () => {
    const answer = await handshake(server.port, "/nowhere");
    assert.equal(answer.status, 404);
    assert.equal(answer.body.toString(), "Not Found");

    await assert.rejects(connect(`${server.url}/nowhere`), /got status 404/);
  });

  test("/rooms/42 reaches its handler with { id: '42' }", async () => {
    const { client, name, connection, context } = await open("/rooms/42");
    assert.equal(name, "room");
    assert.deepEqual(context.params, params({ id: "42" }));
    assert.equal(connection.path, "/rooms/42");
    client.close();
  });

  test("the handler gets the query", async () => {
    const { client, context } = await open("/rooms/42?name=Ada");
    assert.equal(context.query.get("name"), "Ada");
    assert.equal(context.request.path, "/rooms/42");
    client.close();
  });

  test("the first matching route wins", async () => {
    const { client, name, context } = await open("/rooms/lobby");
    assert.equal(name, "lobby");
    assert.deepEqual(context.params, params({}));
    client.close();
  });

  test("params are decoded and every segment has to match", async () => {
    const { client, name, context } = await open("/files/my%20docs/a.txt");
    assert.equal(name, "file");
    assert.deepEqual(
      context.params,
      params({ folder: "my docs", name: "a.txt" }),
    );
    client.close();

    for (const path of [
      "/rooms/",
      "/rooms/42/extra",
      "/Rooms/42",
      "/files/only-one",
      // not valid percent-encoding, so it can't be decoded
      "/rooms/%E0%A4%A",
    ]) {
      assert.equal((await handshake(server.port, path)).status, 404, path);
    }
  });

  test("%2F decodes to / inside a param", async () => {
    const { client, context } = await open("/files/a%2Fb/c.txt");
    assert.deepEqual(context.params, params({ folder: "a/b", name: "c.txt" }));
    client.close();
  });

  test("literal segments match after decoding too", async () => {
    // the client sends /café as /caf%C3%A9
    const café = await open("/café");
    assert.equal(café.name, "café");
    café.client.close();

    // %6C is "l", so this is /rooms/lobby and not a room called "%6Cobby"
    const lobby = await open("/rooms/%6Cobby");
    assert.equal(lobby.name, "lobby");
    lobby.client.close();
  });

  test("a pattern written percent-encoded matches the decoded path", async () => {
    // the pattern is "/na%C3%AFve"; this path is sent as "/na%C3%AFve" too,
    // and "/na%c3%afve" with lowercase hex decodes to the same "naïve"
    for (const path of ["/naïve", "/na%c3%afve"]) {
      const { client, name } = await open(path);
      assert.equal(name, "naïve", path);
      client.close();
    }
  });

  test("a param can be called __proto__", async () => {
    const { client, context } = await open("/proto/x");
    assert.deepEqual(Object.keys(context.params), ["__proto__"]);
    assert.equal(context.params["__proto__"], "x");
    client.close();
  });

  test("/ matches only the root path", async () => {
    const { client, name } = await open("/");
    assert.equal(name, "root");
    client.close();
  });

  test("connect still fires for a routed connection, before the handler", async () => {
    const connects = connected.length;
    const handlers = routed.length;
    const { client, connection } = await open("/rooms/7");
    assert.equal(connected.length, connects + 1);
    assert.deepEqual(connected.at(-1), { connection, handlers });
    client.close();
  });

  test("the router starts reading, so the handler only adds listeners", async () => {
    const { client, connection } = await open("/rooms/8");
    connection.on("message", (message) =>
      connection.send("text", `room 8: ${message.payload}`),
    );
    const reply = nextText(client);
    client.send("text", "hi");
    assert.equal(await reply, "room 8: hi");
    client.close();
  });

  test("route() checks its pattern", () => {
    const router = new WebSocketRouter();
    assert.throws(() => router.route("rooms/:id", () => {}), /start with \//);
    assert.throws(
      () => router.route("/files/:a/:a", () => {}),
      /more than once/,
    );
    assert.throws(() => router.route("/files/:", () => {}), /needs a name/);
  });
});

describe("WebSocketRouter.handle() in the app's request listener", () => {
  let server: Server;
  let handled: string[];
  let router: WebSocketRouter;
  // the app's request listener, set per test
  let listener: (request: WebSocketRequest) => void;

  before(async () => {
    server = await startServer();
    router = new WebSocketRouter().route("/chat", (connection) => {
      handled.push(connection.query.get("token") ?? "");
    });
    server.wsServer.on("request", (request) => listener(request));
  });

  after(() => {
    server.close();
  });

  test("an async auth check runs before the router, which never sees a rejected request", async () => {
    handled = [];
    listener = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (request.query.get("token") !== "secret") {
        request.reject(401);
        return;
      }
      router.handle(request);
    };

    const answer = await handshake(server.port, "/chat?token=wrong");
    assert.equal(answer.status, 401);
    assert.deepEqual(handled, []);

    const client = await connect(`${server.url}/chat?token=secret`);
    assert.deepEqual(handled, ["secret"]);
    client.close();
  });

  test("handle() does nothing with a request that is already answered", async () => {
    handled = [];
    const errors: unknown[] = [];
    listener = (request) => {
      request.reject(403);
      try {
        router.handle(request);
      } catch (error) {
        errors.push(error);
      }
    };

    assert.equal((await handshake(server.port, "/chat")).status, 403);
    assert.deepEqual(errors, []);
    assert.deepEqual(handled, []);
  });

  test("handle() does nothing once the client has gone", async () => {
    handled = [];
    const requested = new Promise<WebSocketRequest>((resolve) => {
      listener = resolve;
    });
    const client = await rawHandshake(server.port, "/chat");
    const request = await requested;

    const closed = once(request, "close");
    client.end();
    await closed;
    router.handle(request);
    assert.equal(request.answered, false);
    assert.deepEqual(handled, []);
  });

  test("a handler that throws closes its connection with 1011, and handle() rethrows", async () => {
    const failing = new WebSocketRouter().route("/chat", () => {
      throw new Error("handler failed");
    });
    const errors: unknown[] = [];
    listener = (request) => {
      try {
        failing.handle(request);
      } catch (error) {
        errors.push(error);
      }
    };

    const client = await connect(`${server.url}/chat`);
    const started = Date.now();
    const [code] = await once(client, "close");
    assert.equal(code, 1011);
    assert.match(String(errors[0]), /handler failed/);
    // the server read the client's close frame and closed the TCP
    // connection, rather than waiting out the 5 s close timeout
    assert.ok(Date.now() - started < 1000);
  });

  test("a connect listener that throws closes the connection with 1011, and handle() rethrows", async () => {
    handled = [];
    const failing = () => {
      throw new Error("connect listener failed");
    };
    server.wsServer.on("connect", failing);
    const errors: unknown[] = [];
    listener = (request) => {
      try {
        router.handle(request);
      } catch (error) {
        errors.push(error);
      }
    };

    try {
      const client = await connect(`${server.url}/chat`);
      const started = Date.now();
      const [code] = await once(client, "close");
      assert.equal(code, 1011);
      assert.match(String(errors[0]), /connect listener failed/);
      // "connect" fires before the route handler, so the handler never ran
      assert.deepEqual(handled, []);
      // the connection was read, so the closing handshake finished early
      assert.ok(Date.now() - started < 1000);
    } finally {
      server.wsServer.off("connect", failing);
    }
  });
});

describe("MessageRouter", () => {
  let server: Server;
  // what the server's handlers received, as [handler, type, data]
  const received: [string, string, unknown][] = [];
  // set by a test to watch the next server connection
  let onConnection: ((connection: WebSocketConnection) => void) | undefined;

  before(async () => {
    server = await startServer();
    const router = new WebSocketRouter();

    // a room where "join" and "say" have handlers and the rest goes to the fallback
    router.route("/rooms/:id", (connection, { params }) => {
      onConnection?.(connection);
      const messages = new MessageRouter(connection);
      messages
        .on("join", (data) => {
          received.push(["join", "join", data]);
          // send() answers with a { type, data } message
          messages.send("joined", { room: params["id"], who: data });
        })
        .on("say", (data, type) => received.push(["say", type, data]))
        .fallback((data, type) => received.push(["fallback", type, data]));
    });

    // no fallback: unknown types are ignored
    router.route("/quiet", (connection) => {
      onConnection?.(connection);
      new MessageRouter(connection).on("ping", () =>
        connection.send("text", JSON.stringify({ type: "pong" })),
      );
    });

    server.wsServer.on("request", (request) => router.handle(request));
  });

  after(() => {
    server.close();
  });

  function send(client: WebSocketConnection, type: string, data?: unknown) {
    client.send("text", JSON.stringify({ type, data }));
  }

  test("each type reaches its handler with its data", async () => {
    received.length = 0;
    const client = await connect(`${server.url}/rooms/42`);
    const reply = nextText(client);
    send(client, "join", "Ada");
    assert.deepEqual(JSON.parse(await reply), {
      type: "joined",
      data: { room: "42", who: "Ada" },
    });

    send(client, "say", { text: "hello" });
    // "join" answers, so once its answer is back the server has handled
    // everything sent before it
    const joined = nextText(client);
    send(client, "join", "Bob");
    await joined;

    assert.deepEqual(received, [
      ["join", "join", "Ada"],
      ["say", "say", { text: "hello" }],
      ["join", "join", "Bob"],
    ]);
    client.close();
  });

  test("an unknown type goes to the fallback", async () => {
    received.length = 0;
    const client = await connect(`${server.url}/rooms/1`);
    send(client, "dance", [1, 2]);
    send(client, "constructor");
    const reply = nextText(client);
    send(client, "join", "Ada");
    await reply;

    assert.deepEqual(received, [
      ["fallback", "dance", [1, 2]],
      ["fallback", "constructor", undefined],
      ["join", "join", "Ada"],
    ]);
    client.close();
  });

  test("without a fallback an unknown type is ignored and the connection stays open", async () => {
    const client = await connect(`${server.url}/quiet`);
    send(client, "dance");
    const reply = nextText(client);
    send(client, "ping");
    assert.deepEqual(JSON.parse(await reply), { type: "pong" });
    assert.equal(client.readyState, "open");
    client.close();
  });

  for (const [label, text] of [
    ["text that isn't JSON", "hello"],
    ["JSON that isn't an object", "[1,2]"],
    ["JSON null", "null"],
    ["an object without a type", '{"data":1}'],
    ["a type that isn't a string", '{"type":7}'],
  ] as const) {
    test(`${label} closes the connection with 1007`, async () => {
      received.length = 0;
      const client = await connect(`${server.url}/rooms/1`);
      const closed = once(client, "close");
      client.send("text", text);
      const [code] = await closed;
      assert.equal(code, 1007);
      assert.deepEqual(received, []);
    });
  }

  test("messages that arrive after the 1007 aren't routed", async () => {
    received.length = 0;
    const client = await connect(`${server.url}/rooms/1`);
    const closed = once(client, "close");
    client.send("text", "not JSON");
    // sent before the client has seen the server's close frame
    send(client, "join", "Ada");
    send(client, "say", "hi");
    const [code] = await closed;
    assert.equal(code, 1007);
    assert.deepEqual(received, []);
  });

  test("binary messages aren't routed and still arrive as binaryMessage", async () => {
    received.length = 0;
    const serverSide = new Promise<WebSocketConnection>((resolve) => {
      onConnection = resolve;
    });
    const client = await connect(`${server.url}/rooms/1`);
    const connection = await serverSide;
    onConnection = undefined;

    const binary = once(connection, "binaryMessage");
    client.send("binary", Buffer.from(JSON.stringify({ type: "join" })));
    const [message] = await binary;
    assert.equal(message.type, "binary");
    assert.deepEqual(received, []);
    assert.equal(connection.readyState, "open");
    client.close();
  });

  test("a type or the fallback can have only one handler", async () => {
    const serverSide = new Promise<WebSocketConnection>((resolve) => {
      onConnection = resolve;
    });
    const client = await connect(`${server.url}/quiet`);
    const connection = await serverSide;
    onConnection = undefined;

    const messages = new MessageRouter(connection).on("a", () => {});
    assert.throws(() => messages.on("a", () => {}), /already has a handler/);
    messages.fallback(() => {});
    assert.throws(() => messages.fallback(() => {}), /already has a handler/);
    client.close();
  });
});
