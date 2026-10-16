// Unit tests for lib/permessage-deflate.ts (RFC 7692). Run with `pnpm test`.
// node:test awaits the promises describe() and test() return by itself.
/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { describe, test } from "node:test";

import {
  MessageTooBigError,
  PerMessageDeflate,
  formatPerMessageDeflate,
  negotiatePerMessageDeflate,
  parseExtensions,
  resolvePerMessageDeflateOptions,
  type PerMessageDeflateOptions,
  type PerMessageDeflateParams,
} from "../lib/permessage-deflate.ts";

/** Negotiates `header` with the server options and formats the answer, or undefined when declined. */
function answer(header: string, options: PerMessageDeflateOptions = {}) {
  const params = negotiatePerMessageDeflate(
    parseExtensions(header),
    resolvePerMessageDeflateOptions(options)!,
  );
  return params && formatPerMessageDeflate(params);
}

const DEFAULT_PARAMS: PerMessageDeflateParams = {
  serverNoContextTakeover: false,
  clientNoContextTakeover: false,
};

const hex = (bytes: string) => Buffer.from(bytes.replace(/ /g, ""), "hex");

/**
 * Inflates `messages` one after another with a strict window of
 * 2^windowBits bytes: one input byte at a time into a 64-byte output buffer,
 * so a back-reference further than the window can't be served from the output
 * and fails with "invalid distance too far back".
 */
async function strictInflate(messages: Buffer[], windowBits: number) {
  const inflate = zlib.createInflateRaw({ windowBits, chunkSize: 64 });
  const results: Buffer[] = [];
  for (const message of messages) {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    inflate.on("data", onData);
    const input = Buffer.concat([message, hex("0000ffff")]);
    await new Promise<void>((resolve, reject) => {
      inflate.once("error", reject);
      for (let i = 0; i < input.length; i++) {
        inflate.write(input.subarray(i, i + 1));
      }
      inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve());
    });
    inflate.off("data", onData);
    results.push(Buffer.concat(chunks));
  }
  inflate.close();
  return results;
}

describe("parseExtensions", () => {
  test("reads extensions, parameters and values", () => {
    assert.deepEqual(
      parseExtensions(
        "foo, bar; baz=2;qux , permessage-deflate; client_max_window_bits",
      ),
      [
        { name: "foo", params: [] },
        {
          name: "bar",
          params: [
            ["baz", "2"],
            ["qux", true],
          ],
        },
        {
          name: "permessage-deflate",
          params: [["client_max_window_bits", true]],
        },
      ],
    );
  });

  test("unquotes quoted values (RFC 6455 section 9.1)", () => {
    assert.deepEqual(
      parseExtensions('permessage-deflate; server_max_window_bits="1\\0"'),
      [
        {
          name: "permessage-deflate",
          params: [["server_max_window_bits", "10"]],
        },
      ],
    );
  });

  test("skips empty list elements and returns nothing for an empty header", () => {
    assert.deepEqual(parseExtensions("foo,, bar"), [
      { name: "foo", params: [] },
      { name: "bar", params: [] },
    ]);
    assert.deepEqual(parseExtensions(""), []);
  });

  for (const header of [
    "foo bar",
    "; foo",
    "foo;",
    "foo=1",
    "foo; bar=",
    "foo; bar=1 2",
    'foo; bar="a b"',
    'foo; bar="unterminated',
    "foo; b@r",
  ]) {
    test(`throws on ${JSON.stringify(header)}`, () => {
      assert.throws(() => parseExtensions(header), SyntaxError);
    });
  }
});

describe("negotiatePerMessageDeflate", () => {
  test("accepts the plain offer", () => {
    assert.equal(answer("permessage-deflate"), "permessage-deflate");
  });

  test("accepts client_max_window_bits without limiting the client by default", () => {
    assert.equal(
      answer("permessage-deflate; client_max_window_bits"),
      "permessage-deflate",
    );
  });

  test("accepts server_no_context_takeover by repeating it", () => {
    assert.equal(
      answer("permessage-deflate; server_no_context_takeover"),
      "permessage-deflate; server_no_context_takeover",
    );
  });

  test("answers server_max_window_bits with the offered value", () => {
    assert.equal(
      answer("permessage-deflate; server_max_window_bits=10"),
      "permessage-deflate; server_max_window_bits=10",
    );
  });

  test("accepts server_max_window_bits=8", () => {
    assert.equal(
      answer("permessage-deflate; server_max_window_bits=8"),
      "permessage-deflate; server_max_window_bits=8",
    );
  });

  test("reads a quoted value", () => {
    assert.equal(
      answer('permessage-deflate; server_max_window_bits="9"'),
      "permessage-deflate; server_max_window_bits=9",
    );
  });

  test("serverMaxWindowBits answers the smaller of the option and the offer", () => {
    const options = { serverMaxWindowBits: 12 };
    assert.equal(
      answer("permessage-deflate; server_max_window_bits=10", options),
      "permessage-deflate; server_max_window_bits=10",
    );
    assert.equal(
      answer("permessage-deflate; server_max_window_bits=14", options),
      "permessage-deflate; server_max_window_bits=12",
    );
    assert.equal(
      answer("permessage-deflate", options),
      "permessage-deflate; server_max_window_bits=12",
    );
  });

  test("clientMaxWindowBits limits a client that supports it, and declines one that doesn't", () => {
    const options = { clientMaxWindowBits: 10 };
    assert.equal(
      answer("permessage-deflate; client_max_window_bits", options),
      "permessage-deflate; client_max_window_bits=10",
    );
    // the client's value is a hint the server may take (RFC 7692 section 7.1.2.2)
    assert.equal(
      answer("permessage-deflate; client_max_window_bits=9", options),
      "permessage-deflate; client_max_window_bits=9",
    );
    assert.equal(answer("permessage-deflate", options), undefined);
  });

  test("the no_context_takeover options are answered even when not offered", () => {
    assert.equal(
      answer("permessage-deflate", {
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      }),
      "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
    );
  });

  for (const offer of [
    "permessage-deflate; foo",
    "permessage-deflate; server_no_context_takeover; server_no_context_takeover",
    "permessage-deflate; server_no_context_takeover=1",
    "permessage-deflate; client_no_context_takeover=true",
    "permessage-deflate; server_max_window_bits",
    "permessage-deflate; server_max_window_bits=7",
    "permessage-deflate; server_max_window_bits=16",
    "permessage-deflate; server_max_window_bits=08",
    "permessage-deflate; server_max_window_bits=ten",
    "permessage-deflate; client_max_window_bits=16",
  ]) {
    test(`declines ${JSON.stringify(offer)} (RFC 7692 section 7)`, () => {
      assert.equal(answer(offer), undefined);
    });
  }

  test("picks the first offer it can accept, ignoring other extensions", () => {
    assert.equal(
      answer(
        "x-webkit-deflate-frame, permessage-deflate; foo, " +
          "permessage-deflate; server_no_context_takeover, permessage-deflate",
      ),
      "permessage-deflate; server_no_context_takeover",
    );
  });

  test("declines when nothing is offered", () => {
    assert.equal(answer(""), undefined);
    assert.equal(answer("x-webkit-deflate-frame"), undefined);
  });
});

describe("resolvePerMessageDeflateOptions", () => {
  test("is off unless turned on", () => {
    assert.equal(resolvePerMessageDeflateOptions(undefined), undefined);
    assert.equal(resolvePerMessageDeflateOptions(false), undefined);
  });

  test("true uses the defaults", () => {
    assert.deepEqual(resolvePerMessageDeflateOptions(true), {
      threshold: 1024,
      serverNoContextTakeover: false,
      clientNoContextTakeover: false,
      serverMaxWindowBits: undefined,
      clientMaxWindowBits: undefined,
    });
  });

  test("rejects window bits outside 8 to 15 and a negative threshold", () => {
    assert.throws(
      () => resolvePerMessageDeflateOptions({ serverMaxWindowBits: 7 }),
      RangeError,
    );
    assert.throws(
      () => resolvePerMessageDeflateOptions({ clientMaxWindowBits: 16 }),
      RangeError,
    );
    assert.throws(
      () => resolvePerMessageDeflateOptions({ threshold: -1 }),
      RangeError,
    );
  });
});

describe("PerMessageDeflate", () => {
  test('compresses "Hello" as in RFC 7692 section 7.2.3.1, without the 00 00 ff ff tail', async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    assert.deepEqual(
      await codec.compress(Buffer.from("Hello")),
      hex("f2 48 cd c9 c9 07 00"),
    );
    codec.close();
  });

  test("takes over the window, so the second message refers to the first (RFC 7692 section 7.2.3.2)", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    await codec.compress(Buffer.from("Hello"));
    assert.deepEqual(
      await codec.compress(Buffer.from("Hello")),
      hex("f2 00 11 00 00"),
    );
    codec.close();
  });

  test("server_no_context_takeover starts every message with an empty window", async () => {
    const codec = new PerMessageDeflate(
      { ...DEFAULT_PARAMS, serverNoContextTakeover: true },
      "server",
    );
    const first = await codec.compress(Buffer.from("Hello"));
    const second = await codec.compress(Buffer.from("Hello"));
    assert.deepEqual(second, first);
    codec.close();
  });

  test("decompresses the examples of RFC 7692 section 7.2.3", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const examples = [
      // one compressed block, then the same message referring to it
      "f2 48 cd c9 c9 07 00",
      "f2 00 11 00 00",
      // a block with no compression
      "00 05 00 fa ff 48 65 6c 6c 6f 00",
      // two blocks
      "f2 48 05 00 00 00 ff ff ca c9 c9 07 00",
    ];
    for (const example of examples) {
      assert.equal(
        (await codec.decompress([hex(example)], 1000)).toString(),
        "Hello",
      );
    }
    codec.close();
  });

  test("a message ending in a BFINAL block doesn't break the next one (RFC 7692 section 7.2.3.4)", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    assert.equal(
      (
        await codec.decompress([hex("f3 48 cd c9 c9 07 00 00")], 1000)
      ).toString(),
      "Hello",
    );
    // the peer had to start a new DEFLATE stream after BFINAL
    assert.equal(
      (await codec.decompress([hex("f2 48 cd c9 c9 07 00")], 1000)).toString(),
      "Hello",
    );
    codec.close();
  });

  test("joins fragments before inflating", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const data = hex("f2 48 cd c9 c9 07 00");
    assert.equal(
      (
        await codec.decompress(
          [data.subarray(0, 2), data.subarray(2, 5), data.subarray(5)],
          1000,
        )
      ).toString(),
      "Hello",
    );
    codec.close();
  });

  test("round-trips between a server and a client over many messages", async () => {
    const server = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const client = new PerMessageDeflate(DEFAULT_PARAMS, "client");
    for (let i = 0; i < 20; i++) {
      const message = Buffer.from(`message ${i} `.repeat(100 + i));
      const compressed = await server.compress(message);
      assert.ok(compressed.length < message.length);
      assert.deepEqual(await client.decompress([compressed], 1e6), message);
    }
    server.close();
    client.close();
  });

  test("compressions queued at once come out in order", async () => {
    const server = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const client = new PerMessageDeflate(DEFAULT_PARAMS, "client");
    const messages = Array.from({ length: 10 }, (_, i) =>
      Buffer.from(`${i}`.repeat(1000 * (10 - i))),
    );
    const compressed = await Promise.all(
      messages.map((m) => server.compress(m)),
    );
    for (const [i, c] of compressed.entries()) {
      assert.deepEqual(await client.decompress([c], 1e6), messages[i]);
    }
    server.close();
    client.close();
  });

  test("a message that inflates past the limit is refused", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const bomb = zlib
      .deflateRawSync(Buffer.alloc(1024 * 1024), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      })
      .subarray(0, -4);
    assert.ok(bomb.length < 2000);
    await assert.rejects(
      codec.decompress([bomb], 64 * 1024),
      MessageTooBigError,
    );
    codec.close();

    // exactly at the limit is fine
    const exact = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    assert.equal(
      (await exact.decompress([bomb], 1024 * 1024)).length,
      1024 * 1024,
    );
    exact.close();
  });

  test("invalid compressed data is refused", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    await assert.rejects(
      codec.decompress([hex("ff ff ff ff")], 1000),
      (error) => !(error instanceof MessageTooBigError),
    );
    codec.close();
  });

  test("server_max_window_bits=8 output decodes with a strict 256-byte window", async () => {
    // Node turns raw deflate windowBits 8 into 9, but zlib never refers more
    // than 2^9 - 262 = 250 bytes back with that window, which fits in 256
    const codec = new PerMessageDeflate(
      { ...DEFAULT_PARAMS, serverMaxWindowBits: 8 },
      "server",
    );
    const messages: Buffer[] = [];
    for (let m = 0; m < 30; m++) {
      // repeats 200 to 510 bytes back, which a 512-byte window could use
      const message = Buffer.alloc(3000);
      randomBytes(510).copy(message);
      for (let i = 510; i < message.length; i++) {
        message[i] = message[i - 200 - ((i * 7) % 311)]!;
      }
      messages.push(message);
    }
    const compressed: Buffer[] = [];
    for (const message of messages) {
      compressed.push(await codec.compress(message));
    }
    assert.deepEqual(await strictInflate(compressed, 8), messages);
    codec.close();

    // the check itself works: a 32 KiB window stream fails it
    const wide = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const wideCompressed: Buffer[] = [];
    for (const message of messages) {
      wideCompressed.push(await wide.compress(message));
    }
    await assert.rejects(strictInflate(wideCompressed, 8), /too far back/);
    wide.close();
  });

  test("close() fails compressions that are still waiting, and later ones", async () => {
    const codec = new PerMessageDeflate(DEFAULT_PARAMS, "server");
    const pending = codec.compress(randomBytes(1024 * 1024));
    codec.close();
    await assert.rejects(pending);
    await assert.rejects(codec.compress(Buffer.from("Hello")));
  });
});
