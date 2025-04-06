type ParseState =
  | "DECODE_HEADER"
  | "WAITING_FOR_16_BIT_LENGTH"
  | "WAITING_FOR_64_BIT_LENGTH"
  | "WAITING_FOR_MASK_KEY"
  | "WAITING_FOR_PAYLOAD"
  | "COMPLETE";

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

  constructor() {
    this.parseState = "DECODE_HEADER";
  }

  public addData(buffer: Buffer): boolean {
    if (this.parseState === "DECODE_HEADER") {
      const firstByte = buffer.readUInt8(0);
      this.fin = (firstByte & 0b10000000) >> 7;
      this.rsv = (firstByte & 0b01110000) >> 4;
      this.opcode = firstByte & 0b00001111;

      const secondByte = buffer.readUInt8(1);
      this.masked = (secondByte & 0b10000000) >> 7;
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
      const lengthBytes = buffer.subarray(2, 4);
      this.payloadLength = lengthBytes.readUint16BE();
      this.parseState = "WAITING_FOR_MASK_KEY";
    }

    if (this.parseState === "WAITING_FOR_64_BIT_LENGTH") {
      const lengthBytes = buffer.subarray(2, 10);
      // TODO: verify if this conversion can lead to an error
      this.payloadLength = Number(lengthBytes.readBigInt64BE());
      this.parseState = "WAITING_FOR_MASK_KEY";
    }

    if (this.parseState === "WAITING_FOR_MASK_KEY") {
      if (this.masked) {
        if (this.payloadLength <= 125) {
          this.maskingKey = buffer.subarray(2, 6);
        } else if (this.payloadLength <= 65535) {
          this.maskingKey = buffer.subarray(4, 8);
        } else if (this.payloadLength <= 18446744073709551615) {
          this.maskingKey = buffer.subarray(10, 14);
        }
        this.parseState = "WAITING_FOR_PAYLOAD";
      } else {
        this.parseState = "WAITING_FOR_PAYLOAD";
      }
    }

    if (this.parseState === "WAITING_FOR_PAYLOAD") {
      if (buffer.length >= this.payloadLength + 2) {
        // TODO: verify is it ok to alloc 0 - probably it's not
        let payload: Buffer = Buffer.alloc(0);
        if (this.payloadLength <= 125) {
          payload = buffer.subarray(6);
        } else if (this.payloadLength <= 65535) {
          payload = buffer.subarray(8, this.payloadLength + 8);
        } else if (this.payloadLength <= 18446744073709551615) {
          payload = buffer.subarray(14);
        }

        const unmaskedPayload = Buffer.alloc(this.payloadLength);

        for (let i = 0; i < this.payloadLength; i++) {
          const unmaskedByte = payload[i] ^ this.maskingKey.readUInt8(i % 4);
          unmaskedPayload.writeUInt8(unmaskedByte, i);
        }

        if (this.opcode === 1) {
          this.textPayload = unmaskedPayload;
        } else if (this.opcode === 2) {
          this.binaryPayload = unmaskedPayload;
        } else {
          this.textPayload = unmaskedPayload;
        }

        this.parseState = "COMPLETE";

        return true;
      }
    }

    return false;
  }

  public setFin(fin: number) {
    this.fin = fin;
    return this;
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

  public setTextPayload(message: string) {
    const payload = Buffer.from(message);
    this.payloadLength = payload.length;
    this.textPayload = payload;
    return this;
  }

  public getBinaryPayload() {
    return this.binaryPayload;
  }

  public setBinaryPayload(message: string) {
    const payload = Buffer.from(message);
    this.payloadLength = payload.length;
    this.textPayload = payload;
    return this;
  }

  public setStatus(status: number) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(status);
    this.payloadLength = buffer.length;
    this.textPayload = buffer;
    return this;
  }

  public toBuffer(): Buffer {
    const firstByte = (this.fin << 7) | (this.rsv << 4) | this.opcode;

    let secondByte = 0x00;

    if (this.payloadLength <= 125) {
      secondByte = (this.masked << 7) | (this.payloadLength << 0);
    } else if (this.payloadLength <= 65535) {
      secondByte = (this.masked << 7) | (0b01111110 << 0);
    } else if (this.payloadLength <= 18446744073709551615) {
      secondByte = (this.masked << 7) | (0b01111111 << 0);
    }

    let extendedLenBuf = undefined;

    if (this.payloadLength > 125 && this.payloadLength <= 65535) {
      extendedLenBuf = Buffer.alloc(2);
      extendedLenBuf.writeUInt16BE(this.payloadLength);
    } else if (
      this.payloadLength > 65535 &&
      this.payloadLength <= 18446744073709551615
    ) {
      extendedLenBuf = Buffer.alloc(8);
      extendedLenBuf.writeBigUInt64BE(BigInt(this.payloadLength));
    }

    const buffer = Buffer.from([
      firstByte,
      secondByte,
      ...(extendedLenBuf ?? []),
      ...this.textPayload,
      ...this.binaryPayload,
    ]);

    return buffer;
  }

  public toString(): string {
    return `fin:${this.fin}rsv:${this.rsv}opcode:${this.opcode}masked:${this.masked}key:${this.maskingKey.toString("ascii")}payloadLength:${this.payloadLength}payload:${this.textPayload.toString("ascii") || this.binaryPayload.toString()}`;
  }
}
