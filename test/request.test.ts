// Tests for the server's "request" event, which lets an app accept or reject
// a connection before it opens. Each test starts its own server on a free port.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import type { WebSocketConnection } from "../lib/web-socket-connection.ts";
import type { WebSocketRequest } from "../lib/web-socket-request.ts";
import { WebSocketServer } from "../lib/web-socket-server.ts";
import { connect, handshake, listen } from "./helpers.ts";

describe("request event", () => {
  let httpServer: Server;
  let wsServer: WebSocketServer;
  let port: number;

  before(async () => {
    httpServer = createServer();
    wsServer = new WebSocketServer(httpServer);
    // read every connection, so the server answers the client's close frame
    wsServer.on("connect", (connection: WebSocketConnection) =>
      connection.addSocketEventListeners(),
    );
    port = await listen(httpServer);
  });

  after(() => {
    httpServer.close();
  });

  /** Uses `listener` as the only "request" listener for one test. */
  function onRequest(listener: (request: WebSocketRequest) => void) {
    wsServer.removeAllListeners("request");
    wsServer.on("request", listener);
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
    assert.equal(answer.body, "Not Found");

    await assert.rejects(
      connect(`ws://127.0.0.1:${port}/nowhere`),
      /got status 404/,
    );
  });

  test("reject() sends the reason as the body", async () => {
    onRequest((request) => request.reject(401, "Missing token"));

    const answer = await handshake(port, "/chat");
    assert.equal(answer.status, 401);
    assert.equal(answer.body, "Missing token");
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

    const client = await connect(`ws://127.0.0.1:${port}/chat?room=1`);
    const [connection] = (await connected) as [WebSocketConnection];
    assert.equal(connection, accepted);

    // the connection works: the server reads and answers
    connection.on("message", (message) =>
      connection.send("text", `echo ${message.payload}`),
    );
    const reply = once(client, "message");
    client.send("text", "hi");
    assert.equal((await reply)[0].payload, "echo hi");
    client.close();
  });

  test("the connection keeps the path, query and headers it was opened with", async () => {
    onRequest((request) => request.accept());
    const connected = once(wsServer, "connect");

    const client = await connect(`ws://127.0.0.1:${port}/rooms/7?name=Ada`);
    const [connection] = (await connected) as [WebSocketConnection];
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

    const client = await connect(`ws://127.0.0.1:${port}/chat?token=good`);
    client.close();
    await assert.rejects(
      connect(`ws://127.0.0.1:${port}/chat?token=bad`),
      /got status 403/,
    );
  });

  test("a request can be answered only once", async () => {
    const errors: unknown[] = [];
    onRequest((request) => {
      request.reject(404);
      assert.equal(request.answered, true);
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
    onRequest((request) => {
      for (const status of [101, 200, 302, 600]) {
        try {
          request.reject(status);
        } catch (error) {
          errors.push(error);
        }
      }
      assert.equal(request.answered, false);
      request.reject(500);
    });

    assert.equal((await handshake(port, "/chat")).status, 500);
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
    const httpServer = createServer();
    const wsServer = new WebSocketServer(httpServer);
    const port = await listen(httpServer);
    wsServer.on("connect", (connection: WebSocketConnection) =>
      connection.addSocketEventListeners(),
    );
    const connected = once(wsServer, "connect");

    const client = await connect(`ws://127.0.0.1:${port}/anything?x=1`);
    const [connection] = (await connected) as [WebSocketConnection];
    assert.equal(connection.path, "/anything");
    assert.equal(connection.query.get("x"), "1");

    client.close();
    httpServer.close();
  });
});
