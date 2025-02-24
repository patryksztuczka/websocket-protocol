import net from "node:net";
import { randomBytes, createHash } from "crypto";

type WebSocketReadyState = "connecting" | "open" | "closing" | "closed";

type WebSocketHandshakeParseResult =
  | {
      isValid: true;
      webSocketAccept: string;
    }
  | {
      isValid: false;
      error: string;
    };

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocket {
  private tcpSocket: net.Socket;
  public readyState: WebSocketReadyState;

  constructor() {
    this.readyState = "connecting";

    this.tcpSocket = net.createConnection({
      port: 80,
    });

    this.tcpSocket.on("connect", () => {
      this.tcpSocket.setEncoding("utf-8");

      const webSocketKey = this.generateWebSocketKey();

      this.tcpSocket.write(
        `GET / HTTP/1.1\r\n` +
          `Host: localhost:80\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${webSocketKey}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`
      );

      this.tcpSocket.on("data", (data) => {
        console.log(data);
        const handshakeResult = this.parseHandshake(data);

        if (!handshakeResult.isValid) {
          this.tcpSocket.destroy();
          this.readyState = "closed";
          return;
        }

        const accept = this.verifyWebSocketAccept(
          webSocketKey,
          handshakeResult.webSocketAccept
        );

        if (!accept) {
          this.tcpSocket.destroy();
          this.readyState = "closed";
          return;
        }

        this.readyState = "open";
      });
    });

    this.tcpSocket.on("error", (error) => {
      throw error;
    });
  }

  private parseHandshake(data: Buffer): WebSocketHandshakeParseResult {
    const lines = data.toLocaleString().split("\r\n");

    const headers = new Map<string, string>();

    // Parse first line
    const [protocol, status] = lines[0].split(" ");

    if (protocol !== "HTTP/1.1" || status !== "101") {
      return {
        isValid: false,
        error: "Handshake failed",
      };
    }

    // Parse headers
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const [key, value] = line.split(":").map((s) => s.trim());
      if (key.toLocaleLowerCase() === "sec-websocket-accept") {
        headers.set(key.toLocaleLowerCase(), value);
      } else {
        headers.set(key.toLocaleLowerCase(), value.toLocaleLowerCase());
      }
    }

    // Validate required headers
    const requiredHeaders = {
      upgrade: "websocket",
      connection: "upgrade",
    };

    for (const [key, value] of Object.entries(requiredHeaders)) {
      if (headers.get(key) !== value) {
        return {
          isValid: false,
          error: `Invalid ${key} header`,
        };
      }
    }

    const webSocketAccept = headers.get("sec-websocket-accept");

    if (!webSocketAccept) {
      return {
        isValid: false,
        error: "Missing Sec-WebSocket-Accept header",
      };
    }

    return {
      isValid: true,
      webSocketAccept,
    };
  }

  private generateWebSocketKey() {
    return randomBytes(16).toString("base64");
  }

  private verifyWebSocketAccept(
    sentKey: string,
    receivedAccept: string
  ): boolean {
    const expectedAccept = createHash("sha1")
      .update(sentKey + WEBSOCKET_GUID)
      .digest("base64");

    return expectedAccept === receivedAccept;
  }
}
