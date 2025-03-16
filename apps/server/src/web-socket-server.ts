import net from "node:net";
import { createHash } from "crypto";
import { sendHttpError } from "./utils/utils.ts";

const PORT = 8080;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type WebSocketFrame = {
  fin: number;
  rsv: number;
  opcode: number;
  masked: number;
  payloadLength: number;
  payload: string;
};

type WebSocketHandshakeParseResult =
  | {
      isValid: true;
      webSocketKey: string;
    }
  | {
      isValid: false;
      error: string;
      httpStatus: number;
    };

type WebSocketFrameParseResult =
  | {
      isValid: true;
      data: WebSocketFrame;
    }
  | {
      isValid: false;
    };

export class WebSocketServer {
  private connections = new Map<
    string,
    { socket: net.Socket; pendingPayload: string | null }
  >();

  constructor() {}

  public run() {
    const server = net.createServer((socket) => {
      socket.on("data", (data) => {
        const conn = this.connections.get(
          `${socket.remoteAddress}:${socket.remotePort}`
        );
        if (conn) {
          const result = this.parseFrame(data);

          if (!result.isValid) {
            // handle
            return;
          }

          const { data: frameData } = result;

          const { fin, opcode, payload } = frameData;

          if (opcode === 0x0 || opcode === 0x1) {
            if (!conn.pendingPayload) {
              conn.pendingPayload = payload;
            } else {
              conn.pendingPayload += payload;
            }
          }

          if (fin && conn.pendingPayload) {
            console.log("WHOLE MESSAGE:", conn.pendingPayload);
            conn.pendingPayload = null;
          }
        } else {
          const handshakeResult = this.parseHandshake(data);

          if (!handshakeResult.isValid) {
            const { httpStatus, error } = handshakeResult;
            socket.write(sendHttpError(httpStatus, error));
            socket.destroy();
            return;
          }

          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Accept: ${this.generateWebSocketAccept(handshakeResult.webSocketKey)}\r\n` +
              `\r\n`
          );
          this.connections.set(`${socket.remoteAddress}:${socket.remotePort}`, {
            socket,
            pendingPayload: null,
          });
        }
      });

      socket.on("close", () => {
        this.connections.delete(`${socket.remoteAddress}:${socket.remotePort}`);
      });
    });

    server.on("error", (error) => {
      throw error;
    });

    server.listen(PORT, "127.0.0.1", undefined, () => {
      console.log(`TCP Server running on port ${PORT}`);
    });
  }

  private parseFrame(buffer: Buffer): WebSocketFrameParseResult {
    const data = [...buffer];
    const firstByte = data[0];
    const fin = (firstByte & 0b10000000) >> 7;
    const rsv = (firstByte & 0b01110000) >> 4;
    const opcode = firstByte & 0b00001111;

    if (opcode < 0x0 || (opcode >= 0x3 && opcode <= 0x7) || opcode > 0xa) {
      return {
        isValid: false,
      };
    }

    const secondByte = data[1];
    const masked = (secondByte & 0b10000000) >> 7;
    if (!masked) {
      return {
        isValid: false,
      };
    }
    const payloadLength = secondByte & 0b01111111;

    const maskingKey = data.slice(2, 6);

    const payload = data.slice(6);

    const unmaskedPayload = [];

    for (let i = 0; i < payloadLength; i++) {
      const unmaskedByte = payload[i] ^ maskingKey[i % 4];
      unmaskedPayload.push(unmaskedByte);
    }

    const decoder = new TextDecoder();

    return {
      isValid: true,
      data: {
        fin,
        rsv,
        opcode,
        masked,
        payloadLength,
        payload: decoder.decode(new Uint8Array(unmaskedPayload)),
      },
    };
  }

  private parseHandshake(data: Buffer): WebSocketHandshakeParseResult {
    const lines = data.toLocaleString().split("\r\n");

    const headers = new Map<string, string>();

    const regex = /^\/(\w+(\/\w+)*)?$/;

    // Parse first line
    const [method, path, protocol] = lines[0].toLocaleString().split(" ");

    if (method !== "GET") {
      return {
        isValid: false,
        httpStatus: 405,
        error: "GET is the only valid method",
      };
    } else if (!regex.test(path)) {
      return {
        isValid: false,
        httpStatus: 403,
        error: "No access to the given resource",
      };
    } else if (protocol !== "HTTP/1.1") {
      return {
        isValid: false,
        httpStatus: 400,
        error: "Wrong protocol used",
      };
    }

    // Parse headers
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const [key, value] = line.split(":").map((s) => s.trim());

      if (key.toLocaleLowerCase() === "sec-websocket-key") {
        headers.set(key.toLocaleLowerCase(), value);
      } else {
        headers.set(key.toLocaleLowerCase(), value.toLocaleLowerCase());
      }
    }

    // Validate required headers
    const requiredHeaders = {
      upgrade: "websocket",
      connection: "upgrade",
      "sec-websocket-version": "13",
    };

    for (const [key, value] of Object.entries(requiredHeaders)) {
      if (headers.get(key) !== value) {
        return {
          isValid: false,
          httpStatus: 400,
          error: `Invalid ${key} header`,
        };
      }
    }

    const webSocketKey = headers.get("sec-websocket-key");

    if (!webSocketKey) {
      return {
        isValid: false,
        httpStatus: 400,
        error: "Missing Sec-WebSocket-Key header",
      };
    }

    const host = headers.get("host");

    if (!host) {
      return {
        isValid: false,
        httpStatus: 400,
        error: "Missing Host header",
      };
    }

    return {
      isValid: true,
      webSocketKey,
    };
  }

  private generateWebSocketAccept(key: string) {
    return createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
  }
}
