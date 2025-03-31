type ParseState =
  | "DECODE_HEADER"
  | "WAITING_FOR_16_BIT_LENGTH"
  | "WAITING_FOR_64_BIT_LENGTH"
  | "WAITING_FOR_MASK_KEY"
  | "WAITING_FOR_PAYLOAD"
  | "COMPLETE";

export class WebSocketFrame {
  private parseState: ParseState;
  public fin: number;
  public rsv: number;
  public opcode: number;
  public masked: number;
  public payloadLength: number;
  public maskingKey: Buffer;
  public binaryPayload: Buffer;

  constructor() {
    this.parseState = "DECODE_HEADER";
  }

  public addData(buffer: Buffer): boolean {
    const data = [...buffer];
    if (this.parseState === "DECODE_HEADER") {
      const firstByte = data[0];
      this.fin = (firstByte & 0b10000000) >> 7;
      this.rsv = (firstByte & 0b01110000) >> 4;
      this.opcode = firstByte & 0b00001111;

      const secondByte = data[1];
      this.masked = (secondByte & 0b10000000) >> 7;
      const payloadLength = secondByte & 0b01111111;

      if (payloadLength >= 0 && payloadLength <= 125) {
        this.parseState = "WAITING_FOR_MASK_KEY";
        this.payloadLength = payloadLength;
      } else if (payloadLength === 126) {
        this.parseState = "WAITING_FOR_16_BIT_LENGTH";
      } else if (payloadLength === 127) {
        this.parseState = "WAITING_FOR_64_BIT_LENGTH";
      } else {
        return false;
      }
    }

    if (this.parseState === "WAITING_FOR_16_BIT_LENGTH") {
      const lengthBytes = data.slice(2, 4);
      const buffer = new Uint8Array(lengthBytes).buffer;
      const view = new DataView(buffer);
      this.payloadLength = view.getUint16(0, false);
      this.parseState = "WAITING_FOR_MASK_KEY";
    }

    if (this.parseState === "WAITING_FOR_64_BIT_LENGTH") {
      const lengthBytes = data.slice(2, 10);
      const buffer = new Uint8Array(lengthBytes).buffer;
      const view = new DataView(buffer);
      this.payloadLength = view.getBigUint64(0, false);
      this.parseState = "WAITING_FOR_MASK_KEY";
    }

    if (this.parseState === "WAITING_FOR_MASK_KEY") {
      if (this.masked) {
        if (this.payloadLength <= 125) {
          this.maskingKey = Buffer.from(data.slice(2, 6));
        } else if (this.payloadLength <= 65535) {
          this.maskingKey = Buffer.from(data.slice(4, 8));
        } else if (this.payloadLength <= 18446744073709551615) {
          this.maskingKey = Buffer.from(data.slice(10, 14));
        }
        this.parseState = "WAITING_FOR_PAYLOAD";
      } else {
        this.parseState = "WAITING_FOR_PAYLOAD";
      }
    }

    if (this.parseState === "WAITING_FOR_PAYLOAD") {
      let payload: number[] = [];

      if (this.payloadLength <= 125) {
        payload = data.slice(6);
      } else if (this.payloadLength <= 65535) {
        payload = data.slice(8);
      } else if (this.payloadLength <= 18446744073709551615) {
        payload = data.slice(14);
      }

      const unmaskedPayload = [];

      for (let i = 0; i < this.payloadLength; i++) {
        const unmaskedByte = payload[i] ^ this.maskingKey.readUInt8(i % 4);
        unmaskedPayload.push(unmaskedByte);
      }

      this.binaryPayload = Buffer.from(unmaskedPayload);
      this.parseState = "COMPLETE";

      return true;
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

  public setOpcode(opcode: number) {
    this.opcode = opcode;
    return this;
  }

  public setMasked(masked: number) {
    this.masked = masked;
    return this;
  }

  public setMessage(message: string) {
    const payload = Buffer.from(message);
    this.payloadLength = payload.length;
    this.binaryPayload = payload;
    return this;
  }

  public setStatus(status: number) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(status);
    this.payloadLength = buffer.length;
    this.binaryPayload = buffer;
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
      extendedLenBuf = Buffer.alloc(2);
      extendedLenBuf.writeBigUInt64BE(BigInt(this.payloadLength));
    }

    const buffer = Buffer.from([
      firstByte,
      secondByte,
      ...(extendedLenBuf ?? []),
      ...this.binaryPayload,
    ]);
    return buffer;
  }

  public toString(): string {
    return `fin:${this.fin}rsv:${this.rsv}opcode:${this.opcode}masked:${this.masked}key:${this.maskingKey?.toString("ascii")}payloadLength:${this.payloadLength}payload:${this.binaryPayload?.toString("ascii")}`;
  }
}
