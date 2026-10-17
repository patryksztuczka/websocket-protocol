# Protocol errors

The server answers a client that breaks RFC 6455 with a close frame carrying the right status code, then closes the connection. Unmasked frames, reserved opcodes or bits, broken fragmentation and oversized or fragmented control frames get 1002. Text that isn't valid UTF-8 gets 1007. Pings are answered with a pong carrying the same payload, even in the middle of a fragmented message.

## Sub-features

- `err-unmasked` closes with 1002 when a client frame isn't masked.
- `err-reserved-opcode` closes with 1002 on a reserved opcode such as 3.
- `err-rsv` closes with 1002 when an RSV bit is set and no extension was agreed.
- `err-fragmentation` closes with 1002 on a continuation with no message started, or on a fragmented control frame.
- `err-control-size` closes with 1002 when a control frame's payload is over 125 bytes.
- `err-utf8` closes with 1007 when text isn't valid UTF-8.
- `ping-pong` answers a ping with a pong carrying the same payload, also between fragments.

## How to get to it (user POV)

- A misbehaving or hostile client sends the frames by hand (`raw.ts`). Normal clients can't produce these frames.
- The full catalogue is covered by Autobahn (`pnpm autobahn`, see the skill's "Outside this skill" section).

## Driving it with drive.ts and raw.ts

Preconditions:

- A run launched with `$S/launch.ts` without `--deflate`, and `VERIFY_RUN` exported.
- `$S/doctor.ts` prints only `OK` lines.

- **Unmasked.** Run `$S/raw.ts --path /echo --name err-unmasked frame:text,mask=0:hi expect-close:1002 expect-eof`. `PASS 3 steps`.
- **Reserved opcode.** Run `$S/raw.ts --path /echo --name err-reserved-opcode frame:3:x expect-close:1002`. `PASS 2 steps`.
- **RSV without an extension.** Run `$S/raw.ts --path /echo --name err-rsv frame:text,rsv=4:hi expect-close:1002`. `PASS 2 steps`.
- **Continuation first.** Run `$S/raw.ts --path /echo --name err-cont-first frame:cont:x expect-close:1002`. `PASS 2 steps`.
- **Fragmented ping.** Run `$S/raw.ts --path /echo --name err-frag-ping frame:ping,fin=0:x expect-close:1002`. `PASS 2 steps`.
- **Control frame over 125 bytes.** Run `$S/raw.ts --path /echo --name err-control-size frame-size:ping:126 expect-close:1002`. `PASS 2 steps`.
- **Invalid UTF-8.** Send `c3 28`, an invalid two-byte sequence. Run `$S/raw.ts --path /echo --name err-utf8 frame-hex:text:c328 expect-close:1007`. `PASS 2 steps`.
- **Ping.** Run `$S/raw.ts --path /echo --name ping frame:ping:are-you-there expect-frame:pong:are-you-there close:1000 expect-close:1000`. `PASS 4 steps`.
- **Ping between fragments.** Run `$S/raw.ts --path /echo --name ping-interleaved frame:text,fin=0:Hel frame:ping:p expect-frame:pong:p frame:cont:lo expect-frame:text:Hello close:1000 expect-close:1000`. `PASS 7 steps`.

## Gotchas

- The `err-rsv` case needs a run without `--deflate`. With compression agreed, RSV1 is legal and means "compressed".
- `expect-close` checks the next frame only. If the server sends something else first, the step fails and shows that frame. Don't skip it.
- The server sends no reason with these close codes, so assert on the code only.
- After any of these errors the server stops reading, so it never receives the client's answering close frame, and its `close` event in `server-events.jsonl` says 1006, not 1002 or 1007. The code the server sent is in the client's `recv-frame`. The `/rooms` 1007 is different: `MessageRouter` closes normally, so the server logs 1007 there.
- Pongs that the client sends unasked are not answered (RFC 6455 section 5.5.3). They show up in `server-events.jsonl` as `pong`.
