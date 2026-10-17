# Handshake and routing

A client's opening handshake gets `101 Switching Protocols` with a valid `Sec-WebSocket-Accept` when it is valid and the app accepts it. An invalid handshake gets `400` or `426`. The app can refuse a request from its `request` listener (`401` here), and `WebSocketRouter` answers `404` for an unknown path. Routes receive `:params` and the query, and `MessageRouter` dispatches JSON messages by type. A client that leaves before an async answer leaves no connection behind.

## Sub-features

- `hs-accept` answers a valid handshake with 101 and a correct `Sec-WebSocket-Accept`.
- `hs-invalid` answers 400 to a request missing `Sec-WebSocket-Key`.
- `hs-version` answers 426 with `Sec-WebSocket-Version: 13` to another version.
- `hs-reject` lets the app reject with its own status (401 without a token).
- `hs-not-found` answers 404 for a path no route matches.
- `route-params` passes `:id` and the query to the route handler.
- `route-messages` dispatches `{type, data}` JSON by type, with a fallback for unknown types.
- `route-bad-json` closes with 1007 when a routed text message isn't a JSON object.
- `hs-gone` notices a client that left before the app answered.

## How to get to it (user POV)

- A raw HTTP upgrade request to any path (`raw.ts`, with headers changed by `--header` and `--omit-header`).
- A WebSocket client connecting to `/private`, `/rooms/:id` or an unknown path (`drive.ts`).

## Driving it with drive.ts and raw.ts

Preconditions:

- A run launched with `$S/launch.ts` (impl `ours`), and `VERIFY_RUN` exported.
- `$S/doctor.ts` prints only `OK` lines.

- **Accept.** Run `$S/raw.ts --path /echo --name hs-accept expect-status:101 close:1000 expect-close:1000`. `PASS 3 steps`, and the `handshake` line shows `"acceptValid":true`.
- **Missing key.** Run `$S/raw.ts --path /echo --omit-header Sec-WebSocket-Key --name hs-invalid expect-status:400`. `PASS 1 steps`, with `HTTP/1.1 400 Bad Request`.
- **Wrong version.** Run `$S/raw.ts --path /echo --header "Sec-WebSocket-Version: 8" --name hs-version expect-status:426 expect-header:sec-websocket-version:13`. `PASS 2 steps`.
- **App rejects.** Run `$S/raw.ts --path /private --name hs-reject expect-status:401`. `PASS 1 steps`. The server logged `reject` with `"status":401`. With the token, `$S/raw.ts --path '/private?token=secret' --name hs-token expect-status:101 frame:text:hi expect-frame:text:hi close:1000 expect-close:1000` prints `PASS 5 steps`.
- **Unknown path.** Run `$S/raw.ts --path /nope --name hs-not-found expect-status:404`. `PASS 1 steps`. The server logged a `request` for `/nope` and no `connect`.
- **Params and message routing.** Run `$S/drive.ts --path '/rooms/42?name=Ada' --name route-messages 'send:{"type":"say","data":"hi"}' 'expect-json:{"type":"said","data":{"room":"42","from":"Ada","text":"hi"}}' 'send:{"type":"dance"}' 'expect-json:{"type":"unknown","data":{"type":"dance"}}'`. `PASS 4 steps`.
- **Bad JSON.** Run `$S/drive.ts --path /rooms/1 --name route-bad-json 'send:not json' expect-close:1007`. `PASS 2 steps`.
- **Client leaves early.** The server waits 500 ms before answering, and the client leaves after 100 ms. Run `$S/raw.ts --path '/private?token=secret&delay=500' --no-wait --name hs-gone wait:100 end expect-eof`. `PASS 3 steps`. `server-events.jsonl` has a `request` for `/private` followed by `request-gone`, and no `connect` for it.

## Gotchas

- Omitting `Upgrade` or `Connection` makes it a plain HTTP request. Node never emits `upgrade` for it, and the verification app has no plain HTTP handler, so the request hangs until `raw.ts` times out. That is `node:http` behaviour, not a library answer. Use the missing key for the 400 case.
- The built-in client reports every refused handshake as a bare connection error. Assert statuses with `raw.ts` only.
- The router's 404 is not logged as `reject`. Only the app's own 401 is. Prove a 404 by the status plus the absence of `connect`.
- `--impl ws` has no routes. Every path echoes there.
