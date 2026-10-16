/**
 * Decodes UTF-8 text that may arrive in pieces, such as the fragments of a
 * text message, and checks it is valid as each piece comes in. Overlong
 * forms, surrogates (U+D800 to U+DFFF) and code points above U+10FFFF are
 * invalid (RFC 3629). For text in a single piece, such as a close reason,
 * call `write(bytes, true)` once.
 */
export class Utf8Decoder {
  private decoder = Utf8Decoder.createDecoder();
  private parts: string[] = [];

  private static createDecoder() {
    // fatal: throw instead of inserting U+FFFD
    // ignoreBOM: keep a leading U+FEFF as part of the text
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  }

  /**
   * Adds the next piece. A character may be split between pieces; `last` says
   * no more pieces follow, so a character left unfinished is invalid. Returns
   * false as soon as the bytes can't be valid UTF-8.
   */
  public write(bytes: Uint8Array, last: boolean): boolean {
    try {
      this.parts.push(this.decoder.decode(bytes, { stream: !last }));
      return true;
    } catch {
      // start over, so the decoder can be used again
      this.decoder = Utf8Decoder.createDecoder();
      this.parts = [];
      return false;
    }
  }

  /** Returns the text written so far and resets for the next text. */
  public end(): string {
    const text = this.parts.join("");
    this.parts = [];
    return text;
  }
}
