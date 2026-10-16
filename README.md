# WebSocket RFC6455 — Educational Implementation

[![RFC6455](https://img.shields.io/badge/WebSocket-RFC%206455-brightgreen)](https://datatracker.ietf.org/doc/html/rfc6455)

A custom, ground-up implementation of the [WebSocket Protocol (RFC 6455)](https://datatracker.ietf.org/doc/html/rfc6455). This repository explores how to establish and handle bi-directional communication between clients and servers using a single TCP connection.

## Table of Contents

- [Overview](#overview)
- [Usage](#usage)
- [To Do](#to-do)
- [Test Suite](#test-suite)

---

## Overview

This project focuses on the essential components of WebSockets:

- **Handshake**: Using the `Upgrade` header to transition from HTTP/1.1 to WebSocket.
- **Framing**: Structuring data in a standard format for transmission.
- **Ping/Pong**: Verifying connection health and liveness.
- **Close**: Gracefully terminating connections with status codes.
- **Masking**: Ensuring security for client-to-server communication via XOR masking.

By taking a low-level approach, the implementation aims to offer a clear, instructive look into how RFC6455 operates under the hood.

It is written in TypeScript and uses only Node's built-in modules. The server is the main focus.

---

## Usage

The server attaches to a `node:http` server and emits `connect` for every accepted connection. Call `addSocketEventListeners()` on the connection to start reading from it.

```ts
import { createServer } from "node:http";

import { WebSocketServer } from "./lib/web-socket-server.ts";

const httpServer = createServer();
const wsServer = new WebSocketServer(httpServer);

wsServer.on("connect", (connection) => {
  // start reading frames from the client
  connection.addSocketEventListeners();

  // a text message; payload is a string
  connection.on("message", (message) => {
    if (message.payload === "bye") {
      connection.close(1000, "See you");
    } else {
      connection.send("text", `You said: ${message.payload}`);
    }
  });

  // a binary message; payload is a Buffer
  connection.on("binaryMessage", (message) => {
    connection.send("binary", message.payload);
  });

  connection.on("close", (code, reason) => {
    console.log(`Connection closed with ${code} ${reason}`);
  });
});

httpServer.listen(8080);
```

`close(code, reason)` starts the closing handshake. The `close` event fires once the TCP connection has closed, with the code and reason from the other side's close frame (1005 if it had no code, 1006 if none arrived). `new WebSocketServer(httpServer, { maxMessageSize, closeTimeout })` sets the largest message accepted (64 MiB by default) and how long to wait for the closing handshake (5 seconds by default).

To decide whether a connection opens, listen to `request`. It fires for every handshake that passed the protocol checks, before the server answers. The request has `path`, `query` (a `URLSearchParams`) and `headers`. Call `accept()` to open the connection, which also emits `connect`, or `reject(status, reason)` to answer with an HTTP error such as 401 or 404 and close the TCP connection. Either can be called later, for example after an async auth check, but only once. If the client leaves before that, the request emits `close` and `request.closed` turns true. After that `accept()` opens nothing and returns `undefined`, and `reject()` does nothing. When nothing listens to `request`, every valid request is accepted. The connection keeps the `path`, `query` and `headers` it was opened with.

```ts
wsServer.on("request", (request) => {
  if (request.path !== "/chat") {
    request.reject(404);
  } else if (request.query.get("token") !== "secret") {
    request.reject(401, "Missing or wrong token");
  } else {
    request.accept();
  }
});
```

The client is `WebSocketClient`. `client.connect("ws://127.0.0.1:8080/")` emits `connect` with a connection that has the same events and methods, or `connectionFailed` with the reason. [`test/scripts/client-test.ts`](test/scripts/client-test.ts) shows it in use.

### Secure WebSockets (`wss://`)

For `wss://`, attach the server to a `node:https` server instead. The client connects to `wss://` addresses on port 443 by default, and the `tls` option is passed on to `https.request`, for example `ca` to trust a self-signed certificate. A TLS error while connecting, such as an untrusted certificate or one that doesn't match `servername`, ends in `connectionFailed`. Invalid TLS options, such as a `cert` or `key` that can't be read or a `servername` that is an IP address, make `connect()` throw instead.

```ts
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

import { WebSocketClient } from "./lib/web-socket-client.ts";
import { WebSocketServer } from "./lib/web-socket-server.ts";

const cert = readFileSync("test/fixtures/localhost-cert.pem");
const key = readFileSync("test/fixtures/localhost-key.pem");

const httpsServer = createServer({ cert, key });
const wsServer = new WebSocketServer(httpsServer);
wsServer.on("connect", (connection) => {
  connection.addSocketEventListeners();
  connection.on("message", (message) =>
    connection.send("text", message.payload),
  );
});
httpsServer.listen(8443);

const client = new WebSocketClient();
client.on("connect", (connection) => {
  connection.on("message", (message) => {
    console.log(message.payload); // "Hello over TLS"
    connection.close();
  });
  connection.send("text", "Hello over TLS");
});
client.on("connectionFailed", (reason) => console.log(reason));
client.connect("wss://localhost:8443/", { tls: { ca: cert } });
```

---

## To Do

### ✔️ Completed

- [x] **Initial Handshake** — Implemented the opening handshake as per RFC 6455. Invalid requests get `400 Bad Request`, and an unsupported `Sec-WebSocket-Version` gets `426 Upgrade Required`.
- [x] **Basic Framing** — Frames with 7-bit, 16-bit and 64-bit payload lengths. A frame is only read once all of it has arrived, so large messages and bursts of small ones are handled without slowing down.
- [x] **Masking Support** — The client masks every frame it sends, and the server closes the connection when a client sends an unmasked frame.
- [x] **Text Message Handling** — Text messages are decoded as UTF-8, including characters split across frames. Invalid UTF-8 closes the connection with 1007.
- [x] **Binary Frame Support** — Binary messages are delivered as a `Buffer`.
- [x] **Fragmentation Support** — Text and binary messages sent in pieces are put back together and delivered as one message.
- [x] **Message Size Limit** — Messages larger than `maxMessageSize` (64 MiB by default) close the connection with 1009.
- [x] **Ping/Pong Frames** — The server answers every ping with a pong. Pongs it receives are not answered. Sending pings of its own (a heartbeat) is not implemented.
- [x] **Opcode Handling** — Properly differentiate and handle control and non-control opcodes. Reserved opcodes and reserved bits close the connection with 1002.
- [x] **Connection Closure** — The closing handshake with status codes, `close(code, reason)` and a `close` event. Invalid close codes are rejected.
- [x] **Client** — The client connects to `ws://` addresses, sends and receives messages, and reports a failed connection with `connectionFailed`.
- [x] **Secure WebSockets (`wss://`)** — The client connects to `wss://` addresses, port 443 by default, and takes TLS options such as `ca`. The server works with an `https.Server`.
- [x] **Client Compliance Testing** — Client tests with `node:test` cover the handshake, text and binary messages, long messages, the closing handshake, failed connections and `wss://`.

### ⏳ Not Done / Planned

- [ ] **Compression** — The `permessage-deflate` extension isn't implemented, so Autobahn sections 12 and 13 are not run. See [#42](https://github.com/patryksztuczka/websocket-protocol/issues/42).
- [ ] **Router Implementation** — Design and implement a lightweight internal router to dispatch messages to appropriate handlers based on message type or path. This is an idea for later, see [#43](https://github.com/patryksztuczka/websocket-protocol/issues/43).

See the [issues page](https://github.com/patryksztuczka/websocket-protocol/issues) for open bugs and planned work.

---

## Test Suite

This project uses the [Autobahn Test Suite](https://github.com/crossbario/autobahn-testsuite) to validate compliance with RFC 6455.

The tests are designed to rigorously evaluate this implementation against a broad set of edge cases and protocol requirements. Sections 1 to 7 and 9 are run on every push and pull request. Sections 12 and 13 test compression, which isn't implemented, and section 10 is not enabled yet. `test/autobahn/config/fuzzingclient.json` sets which cases run.

### 🧪 Running Tests

You need Node 24 or newer, which runs the `.ts` files directly, and [pnpm](https://pnpm.io/). Autobahn also needs [Docker](https://www.docker.com/).

1. Install the dev dependencies:

   ```bash
   pnpm install
   ```

2. Start the echo server. It listens on `127.0.0.1:8080`, or on the address in `HOST` if set. Keep it running for the next steps.

   ```bash
   pnpm server
   ```

3. In another terminal, run the Autobahn suite against the server:

   ```bash
   pnpm autobahn
   ```

   The report is written to `test/autobahn/reports/servers/index.html`.

4. Check the report. This prints a summary per section and exits with an error if any case failed:

   ```bash
   pnpm autobahn:check
   ```

The `node:test` tests for the client and the server's `request` event start their own servers, so they don't need the steps above:

```bash
pnpm test
```

`pnpm check` runs the formatter, the linter and the type checker.
