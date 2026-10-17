# WebSocket library verification map

This directory is the maintained source for verifying what the library does for its users: an app serving WebSocket connections and a program connecting to one. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- `pnpm install` has run, and Node 24 or newer is on `PATH`.
- `S=.claude/skills/verify-websocket/scripts` is set in the shell.
- The run was started with `$S/launch.ts`, with the flags the feature file names, and `VERIFY_RUN` is exported from its `READY` output.
- `$S/doctor.ts` prints only `OK` lines. A run launched before the last edit to `lib/` is stale, so launch a new one.
- Never drive a server this verification didn't launch, except through `--url` on a server you started yourself.

## Driving conventions

- Every recipe starts from a freshly launched run unless its preconditions say otherwise. Runs keep no data, so one run can serve several recipes that need the same launch flags.
- Treat every command as literal. Quote steps that contain spaces, `?`, `&`, `{` or emoji, as the recipes do.
- Use `--name <feature>-<case>` on every drive, so each transcript names what it proves.
- Use `drive.ts` for what an app sees (messages, close codes, negotiated extensions), and `raw.ts` for what only the wire shows (HTTP status, frames, RSV bits, pongs, frames a normal client never sends).
- End raw journeys with `close:1000 expect-close:1000` unless the journey is about a failed connection.

## Proof and skip reporting

- A journey is proven when its command prints `PASS` and exits `0`. Quote the `PASS` or `FAIL` line and the transcript path.
- Pair the client transcript with the matching lines from `verify-artifacts/<run>/server-events.jsonl` whenever the feature has a server-side effect, such as a received message, a close code or a rejected request.
- Record the run id, its launch flags (from `server.json`) and the entry point used with every claim.
- When a step fails, report the step, its reason and the transcript. Don't change the expected value to make it pass.
- Don't report an entry point as verified through a different one. For example, a built-in client journey doesn't verify `WebSocketClient`.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the behaviour users see. It then has exactly four H2 sections, in this order:

1. `Sub-features` lists short IDs, with one line for each behaviour.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with drive.ts and raw.ts` starts with `Preconditions:` and has labelled bullets that pair each action with an exact command and its observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Messages](./messages.md) covers text, binary, UTF-8, fragmented and large messages, the size limit, and both clients over `ws://` and `wss://`.
- [Handshake and routing](./handshake-and-routing.md) covers accepted and refused handshakes, `request` accept and reject, path routes with params, JSON message routing, and a client that leaves before the answer.
- [Closing](./closing.md) covers the closing handshake started by either side, close codes and reasons, and invalid close codes.
- [Compression](./compression.md) covers permessage-deflate negotiation, compressed frames on the wire, the threshold, and the library client against the reference server.
- [Protocol errors](./protocol-errors.md) covers how the server answers broken frames: unmasked, reserved opcodes and bits, bad fragmentation, oversized control frames, invalid UTF-8, and ping and pong.
