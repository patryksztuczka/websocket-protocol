# Messages

A connected client sends text or binary messages and gets them back from an echo route unchanged, whatever their size, characters or fragmentation. A message over the server's size limit closes the connection with 1009. This works over `ws://` and `wss://`, with Node's built-in client and with the library's own `WebSocketClient`.

## Sub-features

- `msg-text` echoes a text message, including multi-byte UTF-8 such as emoji.
- `msg-binary` echoes a binary message byte for byte.
- `msg-large` echoes a message large enough to need the 16-bit and 64-bit length forms.
- `msg-fragmented` joins a message sent in several frames into one message.
- `msg-limit` closes with 1009 when a message is bigger than `maxMessageSize`.
- `msg-tls` echoes over `wss://`.
- `msg-ours-client` sends and receives with the library's `WebSocketClient`.

## How to get to it (user POV)

- Connect to `/echo` with Node's built-in `WebSocket` and send messages (`drive.ts`, the default client).
- Connect with the library's client (`drive.ts --client ours`).
- Send the frames by hand (`raw.ts`), for fragmentation.
- Connect over TLS to a server launched with `--tls`.

## Driving it with drive.ts and raw.ts

Preconditions:

- A run launched with `$S/launch.ts`, and `VERIFY_RUN` exported. `msg-limit` needs a second run launched with `--max-message-size 1000`, and `msg-tls` one launched with `--tls`.
- `$S/doctor.ts` prints only `OK` lines.

- **Text with emoji.** Send and expect the same text. Run `$S/drive.ts --path /echo --name messages-text 'send:Hello 👋' 'expect:Hello 👋'`. `PASS 2 steps`. `server-events.jsonl` has a `message` with `"bytes":10,"text":"Hello 👋"`.
- **Binary.** Run `$S/drive.ts --path /echo --name messages-binary send-hex:0001feff expect-hex:0001feff`. `PASS 2 steps`. The server logged `binary` with `"hex":"0001feff"`.
- **Large.** Run `$S/drive.ts --path /echo --name messages-large send-size:70000 expect-size:70000`. `PASS 2 steps`. A size over 65535 needs the 64-bit length.
- **Fragmented.** Send `Hel` with fin=0, then `lo` as a continuation. Run `$S/raw.ts --path /echo --name messages-fragmented frame:text,fin=0:Hel frame:cont:lo expect-frame:text,fin=1:Hello close:1000 expect-close:1000`. `PASS 5 steps`. One `recv-frame` with `"text":"Hello"`.
- **Library client.** Run `$S/drive.ts --client ours --path /echo --name messages-ours send:hi expect:hi send-hex:00ff expect-hex:00ff`. `PASS 4 steps`.
- **Size limit.** On the run launched with `--max-message-size 1000`, run `$S/drive.ts --path /echo --name messages-limit send-size:1001 expect-close:1009`. `PASS 2 steps`: the close frame the client got carries 1009. `send-size:1000` on the same run still echoes.
- **TLS.** On the run launched with `--tls` (its URL is `wss://localhost:<port>`), run `$S/drive.ts --path /echo --name messages-tls send:secure expect:secure` and `$S/drive.ts --client ours --path /echo --name messages-tls-ours send:secure expect:secure`. Both print `PASS 2 steps`.

## Gotchas

- `send-size` sends ASCII `x` characters, so its byte count equals its length. For multi-byte text use `send:` with the characters themselves.
- With `--deflate`, a large repetitive message is compressed on the wire. That's correct, but it means the large-message case no longer exercises the 64-bit length form there. Use a run without `--deflate` for `msg-large`.
- After a 1009 the server stops reading, so it never sees the client's answering close frame, and its own `close` event in `server-events.jsonl` says 1006. The 1009 is proven by the client side.
- `drive.ts` waits 5 s for each expect step. A 64 MiB message on a slow machine may need `--timeout`.
- The built-in client re-runs itself with `NODE_EXTRA_CA_CERTS` set to the test certificate for `wss://`. A run on another host with a different certificate needs `--url` and its own trust setup.
