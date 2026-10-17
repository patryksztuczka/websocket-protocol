# Closing

Either side can start the closing handshake with a status code and a reason. The other side answers with a close frame, and then the server closes the TCP connection. The app's `close` event reports the code and reason it received. A close frame with a code that may not be sent, such as 1005 or 999, is answered with 1002.

## Sub-features

- `close-client` answers a client's close frame with the same code, then closes TCP.
- `close-server` lets the app start the close with `connection.close(code, reason)`.
- `close-reported` gives the server's `close` event the client's code and reason.
- `close-empty` answers a close frame without a payload with an empty close frame.
- `close-invalid` answers a forbidden close code with 1002.

## How to get to it (user POV)

- A client closes (`drive.ts ... close:<code>:<reason>`, or `raw.ts ... close:<code>`).
- The app closes; the `/close?code=&reason=` route calls `connection.close()` as soon as it connects.

## Driving it with drive.ts and raw.ts

Preconditions:

- A run launched with `$S/launch.ts` (impl `ours`), and `VERIFY_RUN` exported.
- `$S/doctor.ts` prints only `OK` lines.

- **Client closes.** Run `$S/drive.ts --path /echo --name close-client close:4002:bye expect-close:4002`. `PASS 2 steps`. `server-events.jsonl` has `close` with `"code":4002,"reason":"bye"`.
- **Library client closes.** Run `$S/drive.ts --client ours --path /echo --name close-ours send:hi expect:hi close:4001:done expect-close:4001`. `PASS 4 steps`, and the server logged `"code":4001,"reason":"done"`.
- **Server closes.** Run `$S/drive.ts --path '/close?code=4000&reason=bye' --name close-server expect-close:4000`. `PASS 1 steps`.
- **On the wire.** Run `$S/raw.ts --path /echo --name close-wire close:4000:bye expect-close:4000 expect-eof`. `PASS 3 steps`. `recv-frame` shows `"code":4000`, then an `eof` line shows that the server closed TCP.
- **Empty close.** Run `$S/raw.ts --path /echo --name close-empty close expect-frame:close expect-eof`. `PASS 3 steps`, and the `recv-frame` for the close has `"bytes":0`.
- **Forbidden codes.** Run `$S/raw.ts --path /echo --name close-1005 close:1005 expect-close:1002 expect-eof` and `$S/raw.ts --path /echo --name close-999 close:999 expect-close:1002`. Both pass.

## Gotchas

- The server echoes the client's code but not its reason, so the client sees `"reason":""`. Read the reason from the server's `close` event.
- The built-in client only lets an app close with 1000 or 3000-4999. Send other codes with `raw.ts`.
- A `raw.ts` run that ends without a close step destroys the socket, and the server logs `close` with 1006. Don't mistake that for the result of the journey.
- The close event fires when TCP has closed, not when the close frame arrives. Allow for that when you match timestamps.
