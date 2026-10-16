import zlib from "node:zlib";

import type { WebSocketRole } from "./web-socket-connection.ts";

/** The extension name (RFC 7692 section 7). */
export const PERMESSAGE_DEFLATE = "permessage-deflate";

/**
 * Settings for the permessage-deflate extension (RFC 7692). The server_ and
 * client_ prefixes say which side's compressor a setting applies to.
 */
export interface PerMessageDeflateOptions {
  /**
   * Messages smaller than this many bytes are sent uncompressed, since
   * compressing a short message tends to make it bigger. Defaults to 1024.
   */
  threshold?: number;
  /**
   * The server starts every message it sends with an empty window
   * ("server_no_context_takeover"). It compresses less well but the server
   * doesn't keep a window between messages.
   */
  serverNoContextTakeover?: boolean;
  /**
   * Asks the client to start every message with an empty window
   * ("client_no_context_takeover").
   */
  clientNoContextTakeover?: boolean;
  /**
   * The largest window, as a power of 2 from 8 to 15, the server compresses
   * with ("server_max_window_bits"). Defaults to 15, 32 KiB.
   */
  serverMaxWindowBits?: number;
  /**
   * The largest window, as a power of 2 from 8 to 15, the client may compress
   * with ("client_max_window_bits"). An offer from a client that can't be
   * limited is declined. Unset by default, so the client may use 32 KiB.
   */
  clientMaxWindowBits?: number;
}

/** `PerMessageDeflateOptions` with the defaults filled in. */
export interface ResolvedPerMessageDeflateOptions {
  threshold: number;
  serverNoContextTakeover: boolean;
  clientNoContextTakeover: boolean;
  serverMaxWindowBits: number | undefined;
  clientMaxWindowBits: number | undefined;
}

/**
 * The "agreed parameters" (RFC 7692 section 5): what the server's answer
 * says. A window size that is left out means 15.
 */
export interface PerMessageDeflateParams {
  serverNoContextTakeover: boolean;
  clientNoContextTakeover: boolean;
  serverMaxWindowBits?: number;
  clientMaxWindowBits?: number;
}

/** One element of a Sec-WebSocket-Extensions header; a parameter without a value is `true`. */
export interface Extension {
  name: string;
  params: [name: string, value: string | true][];
}

/** 1024 bytes */
export const DEFAULT_COMPRESSION_THRESHOLD = 1024;

const MAX_WINDOW_BITS = 15;

// the empty uncompressed block a Z_SYNC_FLUSH ends with (RFC 7692 section 7.2.1)
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

// a window size: 8 to 15 without leading zeros (RFC 7692 section 7.1.2)
const WINDOW_BITS_REGEX = /^(?:[89]|1[0-5])$/;

// token characters (RFC 7230 section 3.2.6)
const TOKEN_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const isTokenChar = (char: string | undefined) =>
  char !== undefined && TOKEN_REGEX.test(char);

const isWindowBits = (bits: number) =>
  Number.isInteger(bits) && bits >= 8 && bits <= MAX_WINDOW_BITS;

/**
 * Fills in the defaults, or returns undefined when compression is off (the
 * default). Throws a RangeError for a window size outside 8 to 15 or a
 * negative threshold.
 */
export function resolvePerMessageDeflateOptions(
  option: boolean | PerMessageDeflateOptions | undefined,
): ResolvedPerMessageDeflateOptions | undefined {
  if (!option) return undefined;
  const options = option === true ? {} : option;

  const threshold = options.threshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  if (!(threshold >= 0)) {
    throw new RangeError("perMessageDeflate.threshold must be 0 or more");
  }
  for (const name of ["serverMaxWindowBits", "clientMaxWindowBits"] as const) {
    const bits = options[name];
    if (bits !== undefined && !isWindowBits(bits)) {
      throw new RangeError(
        `perMessageDeflate.${name} must be a whole number from 8 to 15`,
      );
    }
  }

  return {
    threshold,
    serverNoContextTakeover: options.serverNoContextTakeover ?? false,
    clientNoContextTakeover: options.clientNoContextTakeover ?? false,
    serverMaxWindowBits: options.serverMaxWindowBits,
    clientMaxWindowBits: options.clientMaxWindowBits,
  };
}

/**
 * Parses a Sec-WebSocket-Extensions header (RFC 6455 section 9.1):
 *
 *     extension-list = 1#extension
 *     extension = extension-token *( ";" extension-param )
 *     extension-param = token [ "=" (token | quoted-string) ]
 *
 * A quoted value must still be a token once unquoted. Several headers arrive
 * joined with ", ", which reads the same. Throws a SyntaxError when the header
 * doesn't follow the grammar.
 */
export function parseExtensions(header: string): Extension[] {
  const extensions: Extension[] = [];
  let i = 0;

  const fail = (): never => {
    throw new SyntaxError(
      `Invalid Sec-WebSocket-Extensions header at character ${i + 1}`,
    );
  };
  const skipSpaces = () => {
    while (header[i] === " " || header[i] === "\t") i++;
  };
  const readToken = () => {
    const start = i;
    while (isTokenChar(header[i])) i++;
    if (i === start) fail();
    return header.slice(start, i);
  };
  const readQuoted = () => {
    // skip the opening quote
    i++;
    let value = "";
    while (header[i] !== '"') {
      if (i >= header.length) fail();
      // a backslash escapes the next character
      if (header[i] === "\\") i++;
      if (i >= header.length) fail();
      value += header[i];
      i++;
    }
    // skip the closing quote
    i++;
    if (!TOKEN_REGEX.test(value)) fail();
    return value;
  };

  while (i < header.length) {
    skipSpaces();
    // a list may have empty elements, as in "a, , b" (RFC 7230 section 7)
    if (header[i] === ",") {
      i++;
      continue;
    }
    if (i >= header.length) break;

    const extension: Extension = { name: readToken(), params: [] };
    skipSpaces();
    while (header[i] === ";") {
      i++;
      skipSpaces();
      const name = readToken();
      skipSpaces();
      let value: string | true = true;
      if (header[i] === "=") {
        i++;
        skipSpaces();
        value = header[i] === '"' ? readQuoted() : readToken();
        skipSpaces();
      }
      extension.params.push([name, value]);
    }
    extensions.push(extension);

    if (i < header.length && header[i] !== ",") fail();
  }

  return extensions;
}

/** Reads a window size, or returns undefined if it isn't 8 to 15 without leading zeros. */
function parseWindowBits(value: string | true): number | undefined {
  return value !== true && WINDOW_BITS_REGEX.test(value)
    ? Number(value)
    : undefined;
}

/**
 * Picks the first permessage-deflate offer the server can accept, in the
 * client's order of preference (RFC 7692 section 5), and returns the agreed
 * parameters. Returns undefined when every offer is declined.
 */
export function negotiatePerMessageDeflate(
  offers: Extension[],
  options: ResolvedPerMessageDeflateOptions,
): PerMessageDeflateParams | undefined {
  for (const offer of offers) {
    if (offer.name !== PERMESSAGE_DEFLATE) continue;
    const params = acceptOffer(offer, options);
    if (params) return params;
  }
  return undefined;
}

/** Accepts one offer, or returns undefined to decline it (RFC 7692 section 7). */
function acceptOffer(
  offer: Extension,
  options: ResolvedPerMessageDeflateOptions,
): PerMessageDeflateParams | undefined {
  const seen = new Set<string>();
  let serverNoContextTakeover = false;
  let serverMaxWindowBits: number | undefined;
  // true when offered without a value
  let clientMaxWindowBits: number | true | undefined;

  for (const [name, value] of offer.params) {
    // a server must decline an offer with a parameter twice, an unknown
    // parameter or an invalid value (RFC 7692 section 7)
    if (seen.has(name)) return undefined;
    seen.add(name);

    switch (name) {
      case "server_no_context_takeover":
        if (value !== true) return undefined;
        serverNoContextTakeover = true;
        break;
      case "client_no_context_takeover":
        // only a hint that the client won't take over its window
        // (RFC 7692 section 7.1.1.2)
        if (value !== true) return undefined;
        break;
      case "server_max_window_bits":
        serverMaxWindowBits = parseWindowBits(value);
        if (serverMaxWindowBits === undefined) return undefined;
        break;
      case "client_max_window_bits":
        if (value === true) {
          clientMaxWindowBits = true;
        } else {
          clientMaxWindowBits = parseWindowBits(value);
          if (clientMaxWindowBits === undefined) return undefined;
        }
        break;
      default:
        return undefined;
    }
  }

  const params: PerMessageDeflateParams = {
    // a requested server_no_context_takeover is accepted by repeating it
    // (RFC 7692 section 7.1.1.1)
    serverNoContextTakeover:
      serverNoContextTakeover || options.serverNoContextTakeover,
    clientNoContextTakeover: options.clientNoContextTakeover,
  };

  // the answer may be the offered size or smaller, and may be given when the
  // client didn't ask (RFC 7692 section 7.1.2.1). Node's zlib compresses raw
  // DEFLATE with a 512-byte window when asked for 8, but never refers more
  // than 250 bytes back with it, so the output still fits a 256-byte window.
  if (
    serverMaxWindowBits !== undefined ||
    options.serverMaxWindowBits !== undefined
  ) {
    params.serverMaxWindowBits = Math.min(
      serverMaxWindowBits ?? MAX_WINDOW_BITS,
      options.serverMaxWindowBits ?? MAX_WINDOW_BITS,
    );
  }

  // the client can only be limited if it says it supports the parameter
  // (RFC 7692 section 7.1.2.2). Its value is a hint the server may take.
  if (options.clientMaxWindowBits !== undefined) {
    if (clientMaxWindowBits === undefined) return undefined;
    params.clientMaxWindowBits = Math.min(
      clientMaxWindowBits === true ? MAX_WINDOW_BITS : clientMaxWindowBits,
      options.clientMaxWindowBits,
    );
  }

  return params;
}

/** Formats agreed parameters as a Sec-WebSocket-Extensions value. */
export function formatPerMessageDeflate(params: PerMessageDeflateParams) {
  let value = PERMESSAGE_DEFLATE;
  if (params.serverNoContextTakeover) value += "; server_no_context_takeover";
  if (params.clientNoContextTakeover) value += "; client_no_context_takeover";
  if (params.serverMaxWindowBits !== undefined) {
    value += `; server_max_window_bits=${params.serverMaxWindowBits}`;
  }
  if (params.clientMaxWindowBits !== undefined) {
    value += `; client_max_window_bits=${params.clientMaxWindowBits}`;
  }
  return value;
}

/** A message inflated past the size limit. */
export class MessageTooBigError extends RangeError {
  constructor() {
    super("The message is bigger than the limit once decompressed");
  }
}

/**
 * Writes `input` to a zlib stream, flushes it and resolves with what came
 * out. Rejects as soon as the output passes `maxLength`, or when the stream
 * fails or is closed. Calls must not overlap on the same stream.
 */
function runZlib(
  stream: zlib.DeflateRaw | zlib.InflateRaw,
  input: Buffer[],
  maxLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;

    const cleanUp = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      // maxOutputLength only applies to zlib's one-shot functions, not to a
      // stream, so the output is counted here
      if (length > maxLength) {
        cleanUp();
        reject(new MessageTooBigError());
        return;
      }
      chunks.push(chunk);
    };
    const onError = (error: Error) => {
      cleanUp();
      reject(error);
    };
    const onClose = () => {
      cleanUp();
      reject(new Error("The compression stream was closed"));
    };

    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("close", onClose);
    for (const chunk of input) stream.write(chunk);
    stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      cleanUp();
      resolve(Buffer.concat(chunks, length));
    });
  });
}

/**
 * Adds an error listener that ignores errors, so one emitted between calls of
 * `runZlib`, such as by a stream being discarded, can't crash the process.
 * `runZlib` reports the errors that happen during a call.
 */
function quiet<T extends zlib.DeflateRaw | zlib.InflateRaw>(stream: T): T {
  stream.on("error", () => {});
  return stream;
}

/**
 * Compresses and decompresses the messages of one connection with the agreed
 * parameters (RFC 7692 section 7.2). Each direction keeps one zlib stream for
 * as long as the connection is open, so the window carries over from one
 * message to the next (context takeover) unless no_context_takeover was
 * agreed. Call `close()` when the connection closes to free them.
 */
export class PerMessageDeflate {
  private deflateWindowBits: number;
  private deflateNoContextTakeover: boolean;
  private inflateWindowBits: number;
  private inflateNoContextTakeover: boolean;
  private deflate: zlib.DeflateRaw | undefined;
  private inflate: zlib.InflateRaw | undefined;
  // compressions run one at a time, in the order they were asked for, so each
  // gets exactly its own output
  private deflateQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Messages smaller than this many bytes are sent uncompressed. */
  public readonly threshold: number;

  constructor(
    params: PerMessageDeflateParams,
    role: WebSocketRole,
    threshold = DEFAULT_COMPRESSION_THRESHOLD,
  ) {
    this.threshold = threshold;
    // the server_ parameters set the server's compressor and the client's
    // decompressor, the client_ ones the other way round (RFC 7692 section 7)
    const own = role === "server" ? "server" : "client";
    const peer = role === "server" ? "client" : "server";
    this.deflateWindowBits = params[`${own}MaxWindowBits`] ?? MAX_WINDOW_BITS;
    this.deflateNoContextTakeover = params[`${own}NoContextTakeover`];
    this.inflateWindowBits = params[`${peer}MaxWindowBits`] ?? MAX_WINDOW_BITS;
    this.inflateNoContextTakeover = params[`${peer}NoContextTakeover`];
  }

  /**
   * Compresses a message (RFC 7692 section 7.2.1): DEFLATE with a sync flush,
   * which ends the data with an empty uncompressed block, then the block's
   * 00 00 ff ff is cut off. Calls may overlap; they finish in order.
   */
  public compress(data: Buffer): Promise<Buffer> {
    const result = this.deflateQueue.then(() => this.runCompress(data));
    this.deflateQueue = result.catch(() => {});
    return result;
  }

  private async runCompress(data: Buffer) {
    if (this.closed) throw new Error("The connection has closed");
    // windowBits 8 is raised to 9 by Node; see acceptOffer
    const deflate = (this.deflate ??= quiet(
      zlib.createDeflateRaw({ windowBits: this.deflateWindowBits }),
    ));

    let compressed: Buffer;
    try {
      compressed = await runZlib(deflate, [data], Infinity);
    } catch (error) {
      this.discardDeflate();
      throw error;
    }

    // forget the window, so the next message starts empty
    if (this.deflateNoContextTakeover) deflate.reset();

    return compressed.subarray(-4).equals(TAIL)
      ? compressed.subarray(0, -4)
      : compressed;
  }

  /**
   * Decompresses a message from the payloads of its frames (RFC 7692 section
   * 7.2.2): appends 00 00 ff ff and inflates. Rejects with a
   * MessageTooBigError once the result passes `maxLength` bytes, or with
   * zlib's error when the data isn't valid DEFLATE. Wait for one call to
   * finish before making the next.
   */
  public async decompress(
    fragments: Buffer[],
    maxLength: number,
  ): Promise<Buffer> {
    if (this.closed) throw new Error("The connection has closed");
    const inflate = (this.inflate ??= quiet(
      zlib.createInflateRaw({ windowBits: this.inflateWindowBits }),
    ));

    let message: Buffer;
    try {
      message = await runZlib(inflate, [...fragments, TAIL], maxLength);
    } catch (error) {
      // the stream is somewhere in the middle of a message now
      this.discardInflate();
      throw error;
    }

    if (inflate.readableEnded) {
      // the message ended with a block that has BFINAL set, which ends the
      // DEFLATE stream (RFC 7692 section 7.2.3.4). The peer starts a new one
      // for its next message, so this side does too. Any data after that
      // block in the same message is ignored on purpose, as ws does.
      this.discardInflate();
    } else if (this.inflateNoContextTakeover) {
      // the peer starts every message with an empty window, so there is no
      // need to keep this one (RFC 7692 section 7.2.2)
      inflate.reset();
    }

    return message;
  }

  private discardDeflate() {
    this.deflate?.close();
    this.deflate = undefined;
  }

  private discardInflate() {
    this.inflate?.close();
    this.inflate = undefined;
  }

  /** Frees both zlib streams. Compressions still waiting are rejected. */
  public close() {
    this.closed = true;
    this.discardDeflate();
    this.discardInflate();
  }
}
