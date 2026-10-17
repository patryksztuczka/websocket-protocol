# WebSocket protocol

A from-scratch implementation of the WebSocket protocol ([RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)) in TypeScript, built to learn how the protocol works. It uses only Node's built-in modules and has no runtime dependencies. The server is the main focus. The client connects to `ws://` and `wss://` addresses and sends and receives messages.

## Running and testing

- The code imports `.ts` files directly. It needs Node 24 or newer (`engines` in `package.json`), which runs them without extra flags.
- Start the echo server with `pnpm server` (`node test/scripts/server-test.ts`). It listens on `127.0.0.1:8080`, or on the address in `HOST` if set.
- With the server running, run Autobahn with `pnpm autobahn`. It needs Docker. The report is written to `test/autobahn/reports/servers/index.html`.
- Then run `pnpm autobahn:check`. It prints a summary per section and exits with an error if any case failed. CI runs the same steps on every push and pull request.
- `test/autobahn/config/fuzzingclient.json` sets which test cases run. Add a section there once the feature it covers works. Cases that still fail because of an open bug are listed in `exclude-cases`; a fix removes its own cases from that list.
- `pnpm bench` compares the server with `ws` on Node. It needs [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/), starts its own servers and takes about 8 minutes. The Benchmarks section of the README explains the cases and the options.
- To find out where time or memory goes, or to prove that a `perf:` change helped, follow `.claude/skills/profile-websocket/SKILL.md`. It profiles under the bench load and compares the working tree with a git ref.
- To prove a change over a real connection, follow `.claude/skills/verify-websocket/SKILL.md`. It launches an isolated server on a free port, drives it with a client or raw frames, keeps the evidence in `verify-artifacts/` and lists a recipe for each feature in `features/`.
- Stop the server by the PID you got when you started it, not by matching its name.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit message: `type: description`, with an optional scope such as `fix(client): ...`. Common types are `feat`, `fix`, `perf`, `refactor`, `test`, `docs` and `chore`. Write the description in plain language and say what changed for someone using the library, for example `fix: text with emoji no longer comes back garbled`.

## Pull requests

Write the PR title and description from [`.github/pull_request_template.md`](.github/pull_request_template.md) and fill in every section. Creating a PR with `gh pr create --body` skips the template, so read it first.
