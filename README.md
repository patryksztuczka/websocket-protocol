# WebSocket RFC6455 — Educational Implementation

[![RFC6455](https://img.shields.io/badge/WebSocket-RFC%206455-brightgreen)](https://datatracker.ietf.org/doc/html/rfc6455)

A custom, ground-up implementation of the [WebSocket Protocol (RFC 6455)](https://datatracker.ietf.org/doc/html/rfc6455). This repository explores how to establish and handle bi-directional communication between clients and servers using a single TCP connection.

## Table of Contents

- [Overview](#overview)
- [Usage](#usage)
- [To Do](#to-do)
- [Test Suite](#test-suite)
- [Benchmarks](#benchmarks)

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

### Routing

`WebSocketRouter` routes connections by path during the handshake, and `MessageRouter` routes a connection's JSON messages by type. Both are in `lib/web-socket-router.ts` and work on top of the events above.

The router doesn't listen to the server by itself. Your `request` listener runs its own checks first and then passes the request to `router.handle()`. This listener takes the place of the one in the previous example, because only one listener should answer each request.

```ts
import { MessageRouter, WebSocketRouter } from "./lib/web-socket-router.ts";

const router = new WebSocketRouter();

wsServer.on("request", async (request) => {
  try {
    // auth first; an async check is fine here, before handle()
    if (!(await isAllowed(request.query.get("token")))) {
      request.reject(401, "Missing or wrong token");
      return;
    }
    router.handle(request);
  } catch (error) {
    // a route handler threw; its connection is already closed with 1011
    console.error(error);
  }
});

async function isAllowed(token: string | null) {
  return token === "secret";
}

router.route("/rooms/:id", (connection, { params, query }) => {
  // "/rooms/42?name=Ada" gives params.id "42" and query.get("name") "Ada"
  const messages = new MessageRouter(connection);

  // { "type": "say", "data": "hi" } calls this handler with "hi"
  messages.on("say", (data) => {
    messages.send("said", {
      room: params["id"],
      from: query.get("name"),
      text: data,
    });
  });

  messages.fallback((_data, type) => {
    console.log(`No handler for ${type}`);
  });
});
```

- Routes are tried in the order they were added, and the first match wins. A `:name` segment matches one non-empty segment. The path and the pattern are compared after percent-decoding, so `/caf%C3%A9` matches `/café`. A param's value is decoded too, and `%2F` in it becomes `/`. A path no route matches gets `404 Not Found` and never a 101.
- `handle()` does nothing if the request has already been answered or the client has left, for example while an auth check was awaiting.
- The router accepts the request, calls the handler and then starts reading, so there is no need to call `addSocketEventListeners()`. A route handler must add its listeners before it returns, because messages that arrive while an async handler waits would be lost. That's why `route()` makes an `async` handler a type error. Do async work before `handle()`. `connect` still fires for every routed connection, before its handler.
- If a route handler or a `connect` listener throws, that connection is closed with 1011 and still read, and `handle()` rethrows the error. Catch it in the `request` listener, as the example does. In an async listener, an uncaught error becomes an unhandled rejection and stops the process.
- Each text message must be a JSON object with a string `type`. Anything else closes the connection with 1007, and later messages on it aren't routed. A type without a handler goes to the fallback, or is ignored if there is no fallback. Each type has one handler, so a second `on()` for the same type throws. `messages.send(type, data)` sends a message in the same shape. An error thrown by a message handler isn't caught.
- Binary messages aren't routed. They still arrive through `binaryMessage`.

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

`connect(url, options)` also takes `maxMessageSize`, `closeTimeout` and `perMessageDeflate`, the same connection settings as the server.

### Compression

Both sides can compress messages with the `permessage-deflate` extension ([RFC 7692](https://datatracker.ietf.org/doc/html/rfc7692)). It is off by default, because every connection that uses it keeps zlib streams in memory while it is open. Turn it on with `perMessageDeflate`:

```ts
// the server accepts a client's offer, with the default settings
const wsServer = new WebSocketServer(httpServer, { perMessageDeflate: true });

// the client makes an offer; an object changes the settings
client.connect("ws://127.0.0.1:8080/", {
  perMessageDeflate: { threshold: 256, serverMaxWindowBits: 10 },
});
```

Compression is only used when both sides agree to it in the handshake. Otherwise messages are sent uncompressed, as before. `send()` and the `message` events work the same either way.

| Option                    | Default | What it does                                                                                                                                                                                                                                  |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threshold`               | `1024`  | Messages smaller than this many bytes are sent uncompressed, since compressing short messages makes them bigger.                                                                                                                              |
| `serverNoContextTakeover` | `false` | The server compresses every message on its own instead of referring back to earlier ones. It compresses less well and uses less memory. A client asks for it and fails the connection if the answer leaves it out.                            |
| `clientNoContextTakeover` | `false` | The same for messages the client sends. A server asks the client for it; a client promises it. A client also follows it when the server's answer asks for it.                                                                                 |
| `serverMaxWindowBits`     | unset   | The largest window (2^8 to 2^15 bytes, given as 8 to 15) the server compresses with. Unset means 15. A client asks for it and fails the connection if the answer leaves the parameter out or gives a larger value (RFC 7692 section 7.1.2.1). |
| `clientMaxWindowBits`     | unset   | The same for the client. A server declines a client that can't be limited. A client also keeps to a smaller value in the server's answer.                                                                                                     |

A compressed message is held to `maxMessageSize` once decompressed, so a small message that would expand to gigabytes closes the connection with 1009.

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
- [x] **Client Compliance Testing** — Client tests with `node:test` cover the handshake, text and binary messages, long messages, the closing handshake, failed connections, `wss://` and compression.
- [x] **Compression** — The server and the client support the `permessage-deflate` extension, including context takeover and window size limits. It is off by default; see [Compression](#compression).
- [x] **Router Implementation** — `WebSocketRouter` sends connections to handlers by path, with `:params`, and answers 404 for a path no route matches. `MessageRouter` sends JSON `{ type, data }` messages to handlers by type, with a fallback for unknown types.

### ⏳ Not Done / Planned

See the [issues page](https://github.com/patryksztuczka/websocket-protocol/issues) for open bugs and planned work.

---

## Test Suite

This project uses the [Autobahn Test Suite](https://github.com/crossbario/autobahn-testsuite) to validate compliance with RFC 6455.

The tests are designed to rigorously evaluate this implementation against a broad set of edge cases and protocol requirements. Sections 1 to 7, 9, 12 and 13 are run on every push and pull request; 12 and 13 test compression, so the echo server turns it on. Section 10 is not enabled yet. `test/autobahn/config/fuzzingclient.json` sets which cases run.

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

The `node:test` tests for the client, the server's `request` event and the routers start their own servers, so they don't need the steps above:

```bash
pnpm test
```

`pnpm check` runs the formatter, the linter and the type checker.

---

## Benchmarks

`pnpm bench` compares this server with [ws](https://github.com/websockets/ws), the most used WebSocket library for Node. Both run as plain echo servers on `node:http` (`bench/servers/`), with compression off, and ws without its optional native add-ons. Every run starts a fresh server process and puts load on it from a separate process. The command prints the median of the runs as a Markdown table and writes every run to `bench/results/`, which is not committed.

It needs [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/), which generates most of the load:

| Case                                  | What it does                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo-16b`, `echo-1kib`, `echo-64kib` | k6 opens 50 connections. Each keeps 10 text messages in flight (4 for 64 KiB) and sends a new one for every echo. Reports echoes per second.                                                                                                                                                                                 |
| `connect`                             | k6 opens 300 connections per second and closes each one once it is open. The rate is fixed: a closed connection can hold its client port for 30 seconds (TIME_WAIT), and one machine has only about 16,000 of them on macOS, so an unlimited run stops connecting after a few seconds. Compare the servers by their CPU use. |
| `latency`                             | 50 connections each send 200 messages of 16 bytes per second. Reports the round-trip time. It uses Node's built-in `WebSocket` client, because k6 measures time in whole milliseconds and a round trip over loopback takes less than one.                                                                                    |

Every case first warms up for 3 seconds, so the JIT compiler has optimized the code before anything is counted, and then measures for 10 seconds. With 3 runs per case and server the whole command takes about 8 minutes. To run part of it or change the times:

```bash
pnpm bench --servers ours --cases echo-16b,latency --runs 5 --seconds 20 --warmup 3
```

Results only compare when the same programs produced them, so the versions are pinned. `bench/versions.json` pins Node, Bun and k6, and `package.json` pins ws. The command looks for each program on `PATH`, and for Node also at the Node running the command. If that isn't the pinned version, it looks for one installed by [mise](https://mise.jdx.dev). If it finds neither, it stops before the first run, names what differs and prints the `mise install` command that gets the pinned versions, such as `mise install node@26.5.0 bun@1.4.3 k6@2.3.0`. `--any-versions` runs on whatever is installed instead, for a quick check whose numbers don't go next to the ones below. The results file records the versions that ran and whether they were the pinned ones. To move to newer versions, change the pins and run the whole benchmark again for the results below.

A server named `ours@<git ref>` runs the library as it was at that ref, with today's echo server, so `--servers ours@master,ours` compares a branch with `master` in one run.

The servers can also run on [Bun](https://bun.com) instead of Node. Add `:bun` to a name, as in `ours:bun`, `ws:bun` or `ours@master:bun`, to run that server on Bun. The server named `bun` is Bun's own WebSocket server, [`Bun.serve`](https://bun.com/docs/runtime/http/websockets), which is native code on top of uWebSockets. On Bun, `import "ws"` loads Bun's own replacement for the package, so `bench/servers/ws.ts` loads the real ws from `node_modules` by its path. The load and the client still run on Node. This compares all of them, in about 20 minutes:

```bash
pnpm bench --servers ours,ws,ours:bun,ws:bun,bun
```

`--profile cpu` or `--profile heap` profiles each server over the measured window and writes the profiles to `--profile-dir` (default `bench/results/profiles`). `--out <file>` sets where the results go. The results file also records the revision and runtime of each server, and its garbage collection count and pause time. Bun doesn't report garbage collections, so those are `null` for servers on Bun, and `--profile` works only with servers on Node. The `profile-websocket` skill (`.claude/skills/profile-websocket/`) builds on these options to summarize profiles and to judge whether a change made the server faster.

Server CPU is the CPU time the server used during the run, as a share of one core. Node runs the server on one thread, so a value near 100% means the server was the limit. It can go a little over 100%, because the garbage collector also works on other threads, in Node and in Bun. A lower value in an echo case means k6 was, so the result says more about the machine than about the server. k6 needs about 7 cores to send 250,000 messages per second.

### Results

On an Apple M5 Pro (15 cores) with macOS and the pinned Node 26.5.0, Bun 1.4.3, k6 2.3.0 and ws 8.22.0, on 17 October 2026, from `pnpm bench --servers ours,ws,ours:bun,ws:bun,bun`:

| Case                              | Server   | Result                                                  | Server CPU | Server peak memory |
| --------------------------------- | -------- | ------------------------------------------------------- | ---------- | ------------------ |
| Echo, 16 B text, 50 connections   | ours     | 220,390 echoes/s                                        | 95%        | 169 MiB            |
| Echo, 16 B text, 50 connections   | ws       | 228,084 echoes/s                                        | 95%        | 141 MiB            |
| Echo, 16 B text, 50 connections   | ours:bun | 219,560 echoes/s                                        | 98%        | 40 MiB             |
| Echo, 16 B text, 50 connections   | ws:bun   | 228,713 echoes/s                                        | 98%        | 44 MiB             |
| Echo, 16 B text, 50 connections   | bun      | 302,830 echoes/s                                        | 84%        | 29 MiB             |
| Echo, 1 KiB text, 50 connections  | ours     | 169,331 echoes/s                                        | 101%       | 203 MiB            |
| Echo, 1 KiB text, 50 connections  | ws       | 177,182 echoes/s                                        | 94%        | 131 MiB            |
| Echo, 1 KiB text, 50 connections  | ours:bun | 162,746 echoes/s                                        | 104%       | 41 MiB             |
| Echo, 1 KiB text, 50 connections  | ws:bun   | 185,877 echoes/s                                        | 101%       | 51 MiB             |
| Echo, 1 KiB text, 50 connections  | bun      | 287,285 echoes/s                                        | 84%        | 19 MiB             |
| Echo, 64 KiB text, 50 connections | ours     | 15,167 echoes/s                                         | 103%       | 309 MiB            |
| Echo, 64 KiB text, 50 connections | ws       | 14,847 echoes/s                                         | 108%       | 338 MiB            |
| Echo, 64 KiB text, 50 connections | ours:bun | 14,989 echoes/s                                         | 116%       | 100 MiB            |
| Echo, 64 KiB text, 50 connections | ws:bun   | 21,297 echoes/s                                         | 105%       | 176 MiB            |
| Echo, 64 KiB text, 50 connections | bun      | 30,859 echoes/s                                         | 102%       | 42 MiB             |
| Open and close 300 connections/s  | ours     | 300 connections/s                                       | 9%         | 140 MiB            |
| Open and close 300 connections/s  | ws       | 300 connections/s                                       | 9%         | 129 MiB            |
| Open and close 300 connections/s  | ours:bun | 300 connections/s                                       | 8%         | 28 MiB             |
| Open and close 300 connections/s  | ws:bun   | 300 connections/s                                       | 8%         | 31 MiB             |
| Open and close 300 connections/s  | bun      | 300 connections/s                                       | 3%         | 8 MiB              |
| Round trip at 10,000 msg/s, 16 B  | ours     | 0.49 p50 ms, 0.79 p99 ms, 2.29 max ms, 8,533 messages/s | 16%        | 124 MiB            |
| Round trip at 10,000 msg/s, 16 B  | ws       | 0.49 p50 ms, 0.76 p99 ms, 3.52 max ms, 8,494 messages/s | 15%        | 106 MiB            |
| Round trip at 10,000 msg/s, 16 B  | ours:bun | 0.49 p50 ms, 0.82 p99 ms, 2.33 max ms, 8,441 messages/s | 14%        | 22 MiB             |
| Round trip at 10,000 msg/s, 16 B  | ws:bun   | 0.49 p50 ms, 0.83 p99 ms, 2.07 max ms, 8,426 messages/s | 14%        | 24 MiB             |
| Round trip at 10,000 msg/s, 16 B  | bun      | 0.48 p50 ms, 0.73 p99 ms, 1.18 max ms, 8,399 messages/s | 9%         | 9 MiB              |

On Node, both servers kept a core busy in the echo cases, so these numbers compare the servers and not k6. ws echoes 3% more 16-byte messages and 5% more 1 KiB messages, and the three runs of each server don't overlap. With 1 KiB messages this server also uses about half as much memory again. With 64 KiB messages this server came out 2% ahead, in this run and in a second one, but an earlier run on the same machine had ws 16% ahead, so call that case even. At this rate the two servers open connections for the same CPU time, and their round-trip times are the same.

On Bun, this server echoes as many messages as on Node, or 4% fewer with 1 KiB messages, and peaks at a fifth to a third of the memory. ws gains more from Bun: 5% more 1 KiB messages than on Node and 43% more 64 KiB messages, which puts it 42% ahead of this server there. Bun's own server, which is native code, echoes twice as many 64 KiB messages as this server. With 16 B and 1 KiB messages it used only 84% of a core, so k6 was the limit and its real rate is higher than the table shows. It also opens connections for a third of the CPU time. Round-trip times are the same for all five servers.
