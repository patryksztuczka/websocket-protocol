import net from "node:net";
import { createHash } from "crypto";
import { sendHttpError } from "./utils/utils.ts";
import { randomBytes } from "node:crypto";

const PORT = 8080;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

export class WebSocketServer {
  private connections = new Map<string, net.Socket>();
  private eventListeners = new Map<string, () => void>();

  constructor() {}

  public run() {
    const server = net.createServer((socket) => {
      socket.on("data", (data) => {
        console.log(data);
        console.log("data from client:", data.toLocaleString().split("\r\n"));
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
        this.connections.set(
          `${socket.remoteAddress}:${socket.remotePort}`,
          socket
        );
      });

      socket.on("close", () => {
        console.log("socket closed connection");
        this.connections.delete(`${socket.remoteAddress}:${socket.remotePort}`);
      });
    });

    server.on("connection", (s) => {
      console.log("socket connected", s.remoteAddress, s.remotePort);
    });

    server.on("error", (error) => {
      throw error;
    });

    server.listen(PORT, "127.0.0.1", undefined, () => {
      console.log(`TCP Server running on port ${PORT}`);
    });
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

  private emit(event: "message") {
    const callback = this.eventListeners.get(event);
    if (callback != undefined) {
      callback();
    }
  }

  public on(event: "message", callback: () => void) {
    this.eventListeners.set(event, callback);
  }
}
