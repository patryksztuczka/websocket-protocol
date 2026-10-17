# Compression

With `perMessageDeflate` on, the server accepts a client's `permessage-deflate` offer. It then compresses messages of at least 1024 bytes (RSV1 set on the frame) and sends shorter ones uncompressed. A client that doesn't offer the extension gets plain frames. The library's client can offer it too, and works with the reference server `ws`. The size limit applies to a message once decompressed.

## Sub-features

- `pmd-negotiate` agrees on `permessage-deflate` with a client that offers it.
- `pmd-wire` sends messages at or over the threshold compressed, with RSV1 set.
- `pmd-threshold` sends messages under the threshold uncompressed.
- `pmd-no-offer` sends plain frames to a client that didn't offer compression.
- `pmd-ours-client` lets the library client offer compression and exchange compressed messages, with our server and with `ws`.
- `pmd-limit` closes with 1009 when a decompressed message is over `maxMessageSize`.

## How to get to it (user POV)

- Node's built-in client offers `permessage-deflate` by itself (`drive.ts`).
- The library's client offers it with `perMessageDeflate` (`drive.ts --client ours --deflate`).
- A hand-made offer (`raw.ts --header "Sec-WebSocket-Extensions: permessage-deflate"`).

## Driving it with drive.ts and raw.ts

Preconditions:

- A run launched with `$S/launch.ts --deflate`, and `VERIFY_RUN` exported. `pmd-limit` needs a run with `--deflate --max-message-size 1000`, and the reference case one with `--impl ws --deflate`.
- `$S/doctor.ts` reports `deflate=true`.

- **Negotiate.** Run `$S/drive.ts --path /echo --name pmd-negotiate send-size:4000 expect-size:4000`. `PASS 2 steps`, and the `open` line shows `"extensions":"permessage-deflate"`. The server's `request` event shows the client's offer in `extensionsOffered`.
- **Compressed on the wire.** Run `$S/raw.ts --path /echo --header "Sec-WebSocket-Extensions: permessage-deflate" --name pmd-wire expect-header:sec-websocket-extensions:permessage-deflate frame-size:text:2000 expect-frame:text,rsv=4 frame:text:small expect-frame:text,rsv=0:small close:1000 expect-close:1000`. `PASS 7 steps`. The 2000-byte echo arrives as a `recv-frame` with `"rsv":4` and about 18 bytes, and `small` with `"rsv":0`.
- **No offer.** Run `$S/raw.ts --path /echo --name pmd-no-offer frame-size:text:2000 expect-frame:text,rsv=0 close:1000 expect-close:1000`. `PASS 4 steps`, with a 2000-byte `recv-frame`.
- **Library client, our server.** Run `$S/drive.ts --client ours --deflate --path /echo --name pmd-ours send-size:5000 expect-size:5000`. `PASS 2 steps`, and `open` shows `permessage-deflate`.
- **Library client, reference server.** On the `--impl ws --deflate` run, run `$S/drive.ts --client ours --deflate --path / --name pmd-ours-ws send-size:5000 expect-size:5000 send-hex:00ff expect-hex:00ff`. `PASS 4 steps`.
- **Decompressed limit.** On the `--deflate --max-message-size 1000` run, run `$S/drive.ts --path /echo --name pmd-limit send-size:4000 expect-close:1009`. `PASS 2 steps`, although the compressed frame is far smaller than 1000 bytes.

## Gotchas

- An equal echo doesn't prove compression. Only `raw.ts` shows RSV1 and the compressed size.
- `raw.ts` doesn't inflate, so a compressed `recv-frame` shows hex, not text. Check its size and `rsv`, not its content.
- A run without `--deflate` answers the offer without the extension. Check `deflate=true` in doctor first.
- `drive.ts --client ours` offers compression only with `--deflate`. The built-in client always offers it.
