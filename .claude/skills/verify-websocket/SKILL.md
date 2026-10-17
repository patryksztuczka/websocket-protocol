---
name: verify-websocket
description: Drive this repo's WebSocket server and client (RFC 6455 library in lib/) end to end and capture proof. Launches an isolated verification server on a free port, checks it with a doctor, drives it with Node's built-in WebSocket client, the library's own WebSocketClient or raw frames, and stops it by PID while keeping the evidence. Use it to prove that a fix or feature works over a real connection (handshake answers, messages, close codes, compression on the wire, routing, TLS) before claiming it does, and read features/README.md for the recipe of each feature.
---

# Verify the WebSocket library

The library has no UI. Its user is an app that serves WebSocket connections with `WebSocketServer` and a program that connects with a client. So verification means: start a real server built on `lib/`, connect to it the way clients do, and record what goes over the wire and what the server saw.

Everything runs from the repository root with Node 24 or newer, after `pnpm install` once. The helpers are in `.claude/skills/verify-websocket/scripts/`. They are executable `.ts` files. The examples use this variable:

```bash
S=.claude/skills/verify-websocket/scripts
```

## Launch

```bash
$S/launch.ts                    # the library's server, plain ws://
$S/launch.ts --deflate          # with permessage-deflate on
$S/launch.ts --tls              # wss://localhost with test/fixtures/localhost-cert.pem
$S/launch.ts --max-message-size 1000   # small limit, to reach 1009 quickly
$S/launch.ts --impl ws [--deflate]     # the reference library ws instead, to test our client
$S/launch.ts --run my-fix       # choose the run id; otherwise a timestamp
```

It starts `scripts/app.ts` in the background on a free port and returns once the server listens. Ready looks like this:

```
READY ws://127.0.0.1:57493 run=20261017T102925-k3f9 pid=67680 impl=ours deflate=false tls=false
Evidence: verify-artifacts/20261017T102925-k3f9
export VERIFY_RUN=20261017T102925-k3f9
```

Run the `export` line, or pass `--run <id>` to every helper. Nothing needs seeding, since the server keeps no data. Each launch gets its own port and its own `verify-artifacts/<run>/`, so several runs can go side by side. The routes of the `ours` server:

| Path                          | Behaviour                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/echo`                       | Echoes text and binary messages                                                                                                                                                                                                 |
| `/close?code=4000&reason=bye` | The server starts the closing handshake at once with that code                                                                                                                                                                  |
| `/rooms/:id?name=Ada`         | `MessageRouter`: `{"type":"say","data":X}` answers `{"type":"said","data":{"room":id,"from":name,"text":X}}`, any other type answers `{"type":"unknown","data":{"type":T}}`, and text that isn't a JSON object closes with 1007 |
| `/private?token=secret`       | Echo, but a missing or wrong token gets `401`. `&delay=<ms>` waits before answering, so a client can leave first                                                                                                                |
| anything else                 | `404` from `WebSocketRouter`                                                                                                                                                                                                    |

`--impl ws` echoes on every path and has no routes.

Node loads `lib/` once, when the server starts. **After editing `lib/`, launch a new run.** Doctor reports a server that runs stale code.

## Doctor

Run it first, and again whenever something looks off:

```bash
$S/doctor.ts --run <id>
```

It checks that the run wasn't stopped, the PID is alive and is this run's `app.ts`, the port is listened on by that PID, a handshake on `/echo` (`/` for `--impl ws`) answers `101` with a valid `Sec-WebSocket-Accept`, and that `HEAD` and the files in `lib/` haven't changed since launch. Every line says `OK` or `FAIL`, and it exits `1` on any failure. On `FAIL server runs the current code`, stop the run and launch a new one. Doctor's handshake shows up in `server-events.jsonl` as a `/echo` connection that closes with 1006. That is expected.

## Drive

There are two drivers. Both take steps as positional arguments, run them in order, stop at the first failing step, print `PASS <n> steps` or `FAIL <step>: <reason>`, exit `0` or `1`, and write a transcript.

**`drive.ts` is a client, the way an app uses one.** It uses Node's built-in `WebSocket` by default, which is an independent implementation (undici) that offers permessage-deflate. With `--client ours` it uses the library's `WebSocketClient`, which offers compression only with `--deflate`.

```bash
$S/drive.ts --path /echo --name echo 'send:Hello 👋' 'expect:Hello 👋' send-hex:0001feff expect-hex:0001feff
$S/drive.ts --client ours --deflate --path /echo --name ours send-size:5000 expect-size:5000
```

The steps are `send:<text>`, `send-hex:<hex>`, `send-size:<n>`, `expect:<text>`, `expect-hex:<hex>`, `expect-json:<json>`, `expect-size:<n>`, `close[:<code>[:<reason>]]`, `expect-close:<code>` and `wait:<ms>`. Without a closing step it ends with a clean `close 1000`. The `open` line shows the negotiated `extensions`. The built-in client can only close with 1000 or 3000-4999, and it reports a refused handshake without the HTTP status, so use `raw.ts` to see the status.

**`raw.ts` speaks bytes.** Use it for handshake answers, frames a client API hides (pong, RSV bits, close payloads) and frames a well-behaved client never sends.

```bash
$S/raw.ts --path /nope --name 404 expect-status:404
$S/raw.ts --path /echo --header "Sec-WebSocket-Version: 8" --name v8 expect-status:426 expect-header:sec-websocket-version:13
$S/raw.ts --path /echo --name unmasked frame:text,mask=0:hi expect-close:1002 expect-eof
$S/raw.ts --path /echo --header "Sec-WebSocket-Extensions: permessage-deflate" --name deflate frame-size:text:2000 expect-frame:text,rsv=4 close:1000 expect-close:1000
```

A frame spec is `<opcode>[,fin=0|1][,mask=0|1][,rsv=0-7]`. The opcode is `cont`, `text`, `binary`, `close`, `ping`, `pong` or a number from 0 to 15. The defaults are `fin=1,mask=1,rsv=0`. The steps are `frame:<spec>:<text>`, `frame-hex:<spec>:<hex>`, `frame-size:<spec>:<n>`, `close[:<code>[:<reason>]]`, `bytes:<hex>`, `end` (send FIN), `wait:<ms>`, `expect-status:<n>`, `expect-header:<name>:<value>`, `expect-frame:<spec>[:<text>]` (checks fin and rsv only when given), `expect-close:<code>` and `expect-eof`. Handshake headers are changed with `--header "Name: value"` and `--omit-header Name`. `--no-wait` starts the steps without waiting for the handshake answer, for example `wait:100 end` to leave early. Every frame received is printed as `recv-frame`, with its opcode, fin, rsv, masked flag, size and text, hex or close code. `expect-frame` and `expect-close` look at the next frame only. Finish with `close:1000 expect-close:1000` to close cleanly. Otherwise the server logs 1006.

Both drivers take `--timeout <ms>` (5000 by default) for each expect step. To drive a server this skill did not launch, use `--url ws://host:port/path --out <dir>` instead of `--run` and `--path`.

The feature map in [`features/README.md`](features/README.md) has the recipe for each feature. Use it rather than improvising.

## Evidence

Everything goes to `verify-artifacts/<run>/`. It is git-ignored and is never deleted by cleanup:

| File                       | What it proves                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcripts/<name>.jsonl` | The client side: handshake request and answer, every frame or message sent and received, and pass or fail for each step                                                                                                                                                                                                                                    |
| `server-events.jsonl`      | The server side, with no client involved: `request` (path, query, extensions offered), `reject`, `request-gone`, `connect`, `message` and `binary` (size and preview), `pong`, `close` (the code and reason of the client's close frame; 1006 when the server didn't read one, as after it failed the connection with 1002, 1007 or 1009), `handler-error` |
| `commands.jsonl`           | Every helper invocation with its arguments, exit code and summary, in order                                                                                                                                                                                                                                                                                |
| `server.json`              | Which code ran: impl, flags, port, PID, git revision, whether `lib/` was dirty, start and stop times                                                                                                                                                                                                                                                       |
| `server.log`               | The server's stdout and stderr, including crashes                                                                                                                                                                                                                                                                                                          |

Proof standards:

- Go over a real connection with a driver. Don't call library internals or test-only setters and call that verification. `pnpm test` covers units; this skill covers behaviour.
- Capture the action and the outcome: the step that sent something, and the frame, message or close that came back. Name each transcript after the feature and case (`--name`).
- Check the server's side too. A client that saw an echo doesn't prove what the server received or which close code it recorded. Quote the matching `server-events.jsonl` lines.
- Show the wire when the wire is the claim. For compression, quote the `recv-frame` with `rsv:4` and its compressed size. A matching echo alone doesn't prove compression.
- When reporting, give the run id, the commands (or `commands.jsonl`) and the transcript paths. Report a failing step with its reason, and don't reword a failure into a pass.

## Cleanup

```bash
$S/stop.ts --run <id>     # the run you launched
$S/stop.ts --all          # every run under verify-artifacts/ whose server still runs
```

`stop.ts` kills only the PID recorded in `server.json`, and only after checking that the PID still runs this run's `app.ts`. It sends SIGTERM, then SIGKILL after 5 s. It marks the run stopped and keeps every file. Never stop servers by process name. Run `stop.ts --all` after a failed attempt too, so no server is left on a port. To delete old evidence, remove `verify-artifacts/<run>` by hand once it's no longer needed.

## Helpers

| Script                         | Use                                                                     |
| ------------------------------ | ----------------------------------------------------------------------- |
| `launch.ts`                    | Start a server and wait until it's ready; prints `READY` and the run id |
| `doctor.ts --run <id>`         | Read-only health check; exits 1 on any `FAIL`                           |
| `drive.ts`                     | Client-level journeys with the built-in or the library client           |
| `raw.ts`                       | Byte-level handshake and frame journeys                                 |
| `stop.ts --run <id>` / `--all` | Stop by recorded PID; evidence stays                                    |
| `app.ts`                       | The server under test; started by `launch.ts`, not by hand              |
| `common.ts`                    | Shared paths and state file                                             |

## Outside this skill

- **Autobahn (`pnpm autobahn`)** is the full RFC 6455 compliance run. It needs `pnpm server` on the fixed port `127.0.0.1:8080` and Docker, so it can't run twice side by side. Check that the port is free first with `lsof -nP -iTCP:8080 -sTCP:LISTEN`. Don't drive or stop a server on 8080 that you didn't start. Start it yourself, note its PID, and stop that PID. Then run `pnpm autobahn:check`.
- **`pnpm test`** runs the `node:test` unit and integration tests, and **`pnpm bench`** compares performance with `ws` (it needs k6).
