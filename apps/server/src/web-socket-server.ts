import net from "node:net";
import { createHash } from "crypto";

const PORT = 80;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type WebSocketHandshakeParseResult =
  | {
      isValid: true;
      webSocketKey: string;
    }
  | {
      isValid: false;
      error: string;
    };

export class WebSocketServer {
  constructor() {
    const server = net.createServer((socket) => {
      socket.on("data", (data) => {
        console.log("data from client:", data.toLocaleString().split("\r\n"));
        const handshakeResult = this.parseHandshake(data);

        if (!handshakeResult.isValid) {
          // 403
          console.log(handshakeResult.error);
          return;
        }

        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Accept: ${this.generateWebSocketAccept(handshakeResult.webSocketKey)}\r\n` +
            `\r\n`
        );
      });
    });

    server.on("error", (error) => {
      throw error;
    });

    server.listen(PORT, undefined, undefined, () => {
      console.log(`TCP Server running on port ${PORT}`);
    });
  }

  private parseHandshake(data: Buffer): WebSocketHandshakeParseResult {
    const lines = data.toLocaleString().split("\r\n");

    const headers = new Map<string, string>();

    const regex = /^\/(\w+(\/\w+)*)?$/;

    // Parse first line
    const [method, path, protocol] = lines[0].toLocaleString().split(" ");

    if (method !== "GET" || !regex.test(path) || protocol !== "HTTP/1.1") {
      return {
        isValid: false,
        error: "Invalid request line",
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
          error: `Invalid ${key} header`,
        };
      }
    }

    const webSocketKey = headers.get("sec-websocket-key");

    if (!webSocketKey) {
      return {
        isValid: false,
        error: "Missing Sec-WebSocket-Key header",
      };
    }

    const host = headers.get("host");

    if (!host) {
      return {
        isValid: false,
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
