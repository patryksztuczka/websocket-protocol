import { randomBytes } from "node:crypto";

import type { ReceiveBuffer } from "./receive-buffer.ts";

type ParseState =
  | "DECODE_HEADER"
  | "WAITING_FOR_16_BIT_LENGTH"
  | "WAITING_FOR_64_BIT_LENGTH"
  | "WAITING_FOR_MASK_KEY"
  | "WAITING_FOR_PAYLOAD"
  | "COMPLETE";

type ParseError =
  | "PAYLOAD_TOO_LARGE"
  | "MESSAGE_TOO_BIG"
  | "INVALID_PAYLOAD_LENGTH"
  | "RESERVED_BITS_USED"
  | "RESERVED_OPCODE_USED"
  | "CONTROL_FRAME_CAN_NOT_BE_FRAGMENTED"
  | "MISSING_MASK"
  | "UNEXPECTED_MASK";

export class WebSocketFrame {
  private parseState: ParseState;
  private fin: number = 0;
  private rsv: number = 0;
  private opcode: number = 0;
  private masked: number = 0;
  private payloadLength: number = 0;
  private maskingKey: Buffer = Buffer.alloc(0);
  private textPayload: Buffer = Buffer.alloc(0);
  private binaryPayload: Buffer = Buffer.alloc(0);
  public error: ParseError | undefined = undefined;

  constructor() {
    this.parseState = "DECODE_HEADER";
  }

  /**
   * Reads the frame from `data`, taking each part (header, extended length,
   * masking key, payload) only once all of its bytes have arrived. Returns
   * false while the frame is incomplete; call it again with the same frame
   * when more data arrives and it carries on where it stopped.
   *
   * `expectMasked` says whether the peer must mask its frames: true when
   * reading frames from a client, false when reading frames from a server
   * (RFC 6455 section 5.1). A data frame whose payload is longer than
   * `maxPayloadLength` fails with "MESSAGE_TOO_BIG" before its payload is read.
   * `compressionAgreed` says whether permessage-deflate was negotiated, which
   * allows RSV1 on the first frame of a text or binary message.
   */
  public addData(
    data: ReceiveBuffer,
    expectMasked: boolean,
    maxPayloadLength: number,
    compressionAgreed = false,
  ): boolean {
    if (this.parseState === "DECODE_HEADER") {
      if (data.length < 2) return false;
      const header = data.consume(2);
      const firstByte = header.readUInt8(0);
      this.fin = (firstByte & 0b10000000) >> 7;
      this.rsv = (firstByte & 0b01110000) >> 4;
      this.opcode = firstByte & 0b00001111;

      // RSV2 and RSV3 have no meaning without an extension that defines them
      // (RFC 6455 section 5.2). RSV1 marks a compressed message once
      // permessage-deflate was agreed, and only on the first frame of a text
      // or binary message, never on a continuation or control frame (RFC 7692
      // section 6.1).
      const rsv1Allowed =
        compressionAgreed && (this.opcode === 0x1 || this.opcode === 0x2);
      if ((this.rsv & 0b011) !== 0 || (this.getRsv1() && !rsv1Allowed)) {
        this.error = "RESERVED_BITS_USED";
        return false;
      }

      if (
        (this.opcode >= 3 && this.opcode <= 7) ||
        (this.opcode >= 11 && this.opcode <= 15)
      ) {
        this.error = "RESERVED_OPCODE_USED";
        return false;
      }

      if (
        !this.fin &&
        (this.opcode === 8 || this.opcode === 9 || this.opcode === 10)
      ) {
        this.error = "CONTROL_FRAME_CAN_NOT_BE_FRAGMENTED";
        return false;
      }

      const secondByte = header.readUInt8(1);
      this.masked = (secondByte & 0b10000000) >> 7;

      // a server must close the connection on an unmasked frame and a client
      // on a masked one (RFC 6455 section 5.1)
      if (expectMasked && !this.masked) {
        this.error = "MISSING_MASK";
        return false;
      }
      if (!expectMasked && this.masked) {
        this.error = "UNEXPECTED_MASK";
        return false;
      }

      const length = secondByte & 0b01111111;

      if (length >= 0 && length <= 125) {
        this.parseState = "WAITING_FOR_MASK_KEY";
        this.payloadLength = length;
      } else if (length === 126) {
        this.parseState = "WAITING_FOR_16_BIT_LENGTH";
      } else if (length === 127) {
        this.parseState = "WAITING_FOR_64_BIT_LENGTH";
      } else {
        return false;
      }
    }

    if (this.parseState === "WAITING_FOR_16_BIT_LENGTH") {
      if (data.length < 2) return false;
      this.payloadLength = data.consume(2).readUInt16BE(0);
      this.parseState = "WAITING_FOR_MASK_KEY";
    }

    if (this.parseState === "WAITING_FOR_64_BIT_LENGTH") {
      if (data.length < 8) return false;
      const length = data.consume(8).readBigUInt64BE(0);
      // the most significant bit MUST be 0 (RFC 6455 section 5.2)
      if (length >> 63n !== 0n) {
        this.error = "INVALID_PAYLOAD_LENGTH";
        return false;
      }
      // larger lengths can't be stored in a number without losing precision
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.error = "MESSAGE_TOO_BIG";
        return false;
      }
      this.payloadLength = Number(length);
      this.parseState = "WAITING_FOR_MASK_KEY";
    }

    if (this.opcode === 8 || this.opcode === 9 || this.opcode === 10) {
      if (this.payloadLength > 125) {
        this.error = "PAYLOAD_TOO_LARGE";
        return false;
      }
    } else if (this.payloadLength > maxPayloadLength) {
      // refuse it before the payload is buffered (RFC 6455 section 7.4.1, 1009)
      this.error = "MESSAGE_TOO_BIG";
      return false;
    }

    if (this.parseState === "WAITING_FOR_MASK_KEY") {
      if (this.masked) {
        if (data.length < 4) return false;
        this.maskingKey = data.consume(4);
      }
      this.parseState = "WAITING_FOR_PAYLOAD";
    }

    if (this.parseState === "WAITING_FOR_PAYLOAD") {
      // wait until the whole payload has arrived
      if (data.length < this.payloadLength) return false;

      const payload = data.consume(this.payloadLength);

      // the payload is masked only when the MASK bit is set (RFC 6455 section 5.3)
      if (this.masked) {
        for (let i = 0; i < this.payloadLength; i++) {
          payload[i] ^= this.maskingKey[i % 4];
        }
      }

      if (this.opcode === 1) {
        this.textPayload = payload;
      } else if (this.opcode === 2) {
        this.binaryPayload = payload;
      } else {
        this.textPayload = payload;
      }

      this.parseState = "COMPLETE";

      return true;
    }

    return false;
  }

  /** Length of the payload in bytes. */
  public getPayloadLength() {
    return this.payloadLength;
  }

  public getFin() {
    return this.fin;
  }

  public setFin(fin: number) {
    this.fin = fin;
    return this;
  }

  /** 1 when RSV1, the "Per-Message Compressed" bit, is set (RFC 7692 section 6). */
  public getRsv1() {
    return (this.rsv & 0b100) >> 2;
  }

  public setRsv(rsv: number) {
    this.rsv = rsv;
    return this;
  }

  public getOpcode() {
    return this.opcode;
  }

  public setOpcode(opcode: number) {
    this.opcode = opcode;
    return this;
  }

  public setMasked(masked: number) {
    this.masked = masked;
    return this;
  }

  public getTextPayload() {
    return this.textPayload;
  }

  public setTextPayload(message: string | Buffer) {
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    this.payloadLength = payload.length;
    this.textPayload = payload;
    return this;
  }

  public getBinaryPayload() {
    return this.binaryPayload;
  }

  public setBinaryPayload(message: string | Buffer) {
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    this.payloadLength = payload.length;
    this.binaryPayload = payload;
    return this;
  }

  /**
   * Encodes the frame for sending. When the frame is masked, a fresh random
   * masking key is made on every call and the payload is masked into a new
   * buffer, so the buffer passed to setTextPayload/setBinaryPayload is left
   * unchanged (RFC 6455 sections 5.2 and 5.3).
   */
  public toBuffer(): Buffer {
    const firstByte = (this.fin << 7) | (this.rsv << 4) | this.opcode;

    // 7-bit length, or 126/127 followed by a 16/64-bit length (RFC 6455 section 5.2)
    let lengthField: number;
    let extendedLength: number;
    if (this.payloadLength <= 125) {
      lengthField = this.payloadLength;
      extendedLength = 0;
    } else if (this.payloadLength <= 65535) {
      lengthField = 126;
      extendedLength = 2;
    } else {
      lengthField = 127;
      extendedLength = 8;
    }

    const maskOffset = 2 + extendedLength;
    const header = Buffer.alloc(maskOffset + (this.masked ? 4 : 0));
    header[0] = firstByte;
    header[1] = (this.masked << 7) | lengthField;
    if (extendedLength === 2) {
      header.writeUInt16BE(this.payloadLength, 2);
    } else if (extendedLength === 8) {
      header.writeBigUInt64BE(BigInt(this.payloadLength), 2);
    }

    // Buffer.concat copies, so masking `frame` leaves the caller's payload alone
    const frame = Buffer.concat([header, this.textPayload, this.binaryPayload]);

    if (this.masked) {
      // a new, unpredictable key for every frame (RFC 6455 sections 5.3 and 10.3)
      this.maskingKey = randomBytes(4);
      this.maskingKey.copy(frame, maskOffset);
      for (let i = 0; i < this.payloadLength; i++) {
        frame[header.length + i] ^= this.maskingKey[i % 4];
      }
    }

    return frame;
  }

  public toString(): string {
    return `fin:${this.fin}rsv:${this.rsv}opcode:${this.opcode}masked:${this.masked}key:${this.maskingKey.toString("ascii")}payloadLength:${this.payloadLength}payload:${this.textPayload.toString("ascii") || this.binaryPayload.toString()}`;
  }
}
