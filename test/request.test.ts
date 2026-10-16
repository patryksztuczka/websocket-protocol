// Tests for the server's "request" event, which lets an app accept or reject
// a connection before it opens. Each suite starts its own server on a free port.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";

import type { WebSocketConnection } from "../lib/web-socket-connection.ts";
import type { WebSocketRequest } from "../lib/web-socket-request.ts";
import type { WebSocketServer } from "../lib/web-socket-server.ts";
import { connect, handshake, rawHandshake, startServer } from "./helpers.ts";

/** The connections the server keeps track of, read from its private field. */
function trackedConnections(wsServer: WebSocketServer): unknown[] {
  return Reflect.get(wsServer, "connections");
}

describe("request event", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let wsServer: WebSocketServer;
  let port: number;
  let url: string;

  before(async () => {
    server = await startServer();
    ({ wsServer, port, url } = server);
    // read every connection, so the server answers the client's close frame
    wsServer.on("connect", (connection) =>
      connection.addSocketEventListeners(),
    );
  });

  after(() => {
    server.close();
  });

  /** Uses `listener` as the only "request" listener for one test. */
  function onRequest(listener: (request: WebSocketRequest) => void) {
    wsServer.removeAllListeners("request");
    wsServer.on("request", listener);
  }

  /** Resolves with the next request, which nothing answers. */
  function nextRequest(): Promise<WebSocketRequest> {
    return new Promise((resolve) => onRequest(resolve));
  }

  test("has the path, query and headers of the handshake", async () => {
    const requests: WebSocketRequest[] = [];
    onRequest((request) => {
      requests.push(request);
      request.reject(404);
    });

    await handshake(port, "/rooms/42?name=Ada&tag=a&tag=b", {
      "x-token": "secret",
    });

    const [request] = requests;
    assert.ok(request);
    assert.equal(request.path, "/rooms/42");
    assert.equal(request.query.get("name"), "Ada");
    assert.deepEqual(request.query.getAll("tag"), ["a", "b"]);
    assert.equal(request.headers["x-token"], "secret");
    assert.equal(request.headers["sec-websocket-version"], "13");
  });

  test("reject(404) answers 404 and never 101", async () => {
    onRequest((request) => request.reject(404));

    const answer = await handshake(port, "/nowhere");
    assert.equal(answer.status, 404);
    assert.equal(answer.headers["connection"], "close");
    assert.equal(answer.body.toString(), "Not Found");

    await assert.rejects(connect(`${url}/nowhere`), /got status 404/);
  });

  test("reject() sends the reason as the body", async () => {
    onRequest((request) => request.reject(401, "Missing token"));

    const answer = await handshake(port, "/chat");
    assert.equal(answer.status, 401);
    assert.equal(answer.body.toString(), "Missing token");
  });

  test("reject() sends a non-ASCII reason as UTF-8 with its byte length", async () => {
    const reason = "zażółć 😀";
    onRequest((request) => request.reject(401, reason));

    const answer = await handshake(port, "/chat");
    assert.equal(answer.status, 401);
    // 9 characters, 15 bytes: ż ó ł ć take 2 bytes each and 😀 takes 4
    assert.equal(answer.headers["content-length"], "15");
    assert.deepEqual(answer.body, Buffer.from(reason, "utf8"));
  });

  test("a rejected request never emits connect", async () => {
    let connects = 0;
    const countConnect = () => connects++;
    wsServer.on("connect", countConnect);
    onRequest((request) => request.reject(403));

    await handshake(port, "/chat");
    wsServer.off("connect", countConnect);
    assert.equal(connects, 0);
  });

  test("accept() opens the connection, emits connect and returns the connection", async () => {
    let accepted: WebSocketConnection | undefined;
    onRequest((request) => {
      accepted = request.accept();
    });
    const connected = once(wsServer, "connect");

    const client = await connect(`${url}/chat?room=1`);
    const [connection] = await connected;
    assert.ok(accepted);
    assert.equal(connection, accepted);

    // the connection works: the server reads and answers
    connection.on("message", (message) =>
      connection.send("text", `echo ${message.payload}`),
    );
    const reply = once(client, "message");
    client.send("text", "hi");
    assert.equal((await reply)[0].payload, "echo hi");

    // once it has closed, the server forgets it
    const closed = once(connection, "close");
    client.close();
    await closed;
    assert.ok(!trackedConnections(wsServer).includes(connection));
  });

  test("the connection keeps the path, query and headers it was opened with", async () => {
    onRequest((request) => request.accept());
    const connected = once(wsServer, "connect");

    const client = await connect(`${url}/rooms/7?name=Ada`);
    const [connection] = await connected;
    assert.equal(connection.path, "/rooms/7");
    assert.equal(connection.query.get("name"), "Ada");
    assert.equal(connection.headers["host"], `127.0.0.1:${port}`);

    // the client's side knows the path and query it asked for too
    assert.equal(client.path, "/rooms/7");
    assert.equal(client.query.get("name"), "Ada");
    client.close();
  });

  test("the answer can wait, for example for an async auth check", async () => {
    onRequest((request) => {
      setTimeout(() => {
        if (request.query.get("token") === "good") request.accept();
        else request.reject(403);
      }, 20);
    });

    const client = await connect(`${url}/chat?token=good`);
    client.close();
    await assert.rejects(connect(`${url}/chat?token=bad`), /got status 403/);
  });

  test("a client that ends the connection while the app decides", async () => {
    const requested = nextRequest();
    const client = await rawHandshake(port, "/chat");
    const request = await requested;
    const tracked = trackedConnections(wsServer).length;
    let connects = 0;
    const countConnect = () => connects++;
    wsServer.on("connect", countConnect);

    // the server ends its side too, so the socket isn't held open
    const serverEnded = once(client, "end");
    const requestClosed = once(request, "close");
    client.end();
    await requestClosed;
    await serverEnded;
    assert.equal(request.closed, true);

    // accept() has no one to open a connection for
    assert.equal(request.accept(), undefined);
    // and reject() has no one to answer
    request.reject(403);
    assert.equal(request.answered, false);

    wsServer.off("connect", countConnect);
    assert.equal(connects, 0);
    assert.equal(trackedConnections(wsServer).length, tracked);
  });

  test("a client that resets the connection while the app decides doesn't crash the process", async () => {
    const requested = nextRequest();
    const client = await rawHandshake(port, "/chat");
    const request = await requested;

    const requestClosed = once(request, "close");
    client.resetAndDestroy();
    await requestClosed;
    assert.equal(request.closed, true);
    assert.equal(request.accept(), undefined);
    request.reject(403);
  });

  test("a request can be answered only once", async () => {
    const errors: unknown[] = [];
    onRequest((request) => {
      request.reject(404);
      try {
        request.accept();
      } catch (error) {
        errors.push(error);
      }
      try {
        request.reject(400);
      } catch (error) {
        errors.push(error);
      }
    });

    assert.equal((await handshake(port, "/chat")).status, 404);
    assert.equal(errors.length, 2);
    assert.match(String(errors[0]), /already been answered/);
  });

  test("reject() only takes 4xx and 5xx statuses", async () => {
    const errors: unknown[] = [];
    let answeredAfterErrors: boolean | undefined;
    onRequest((request) => {
      for (const status of [101, 200, 302, 600]) {
        try {
          request.reject(status);
        } catch (error) {
          errors.push(error);
        }
      }
      answeredAfterErrors = request.answered;
      request.reject(500);
    });

    assert.equal((await handshake(port, "/chat")).status, 500);
    assert.equal(answeredAfterErrors, false);
    assert.equal(errors.length, 4);
    assert.ok(errors.every((error) => error instanceof RangeError));
  });

  test("an invalid handshake gets 400 and never reaches the request event", async () => {
    let requests = 0;
    onRequest(() => requests++);

    const answer = await handshake(port, "/chat", {
      "sec-websocket-key": "too short",
    });
    assert.equal(answer.status, 400);
    assert.equal(requests, 0);
  });
});

describe("without a request listener", () => {
  test("every valid request is accepted and emits connect, as before", async () => {
    const server = await startServer();
    server.wsServer.on("connect", (connection) =>
      connection.addSocketEventListeners(),
    );
    const connected = once(server.wsServer, "connect");

    const client = await connect(`${server.url}/anything?x=1`);
    const [connection] = await connected;
    assert.equal(connection.path, "/anything");
    assert.equal(connection.query.get("x"), "1");

    client.close();
    server.close();
  });
});
