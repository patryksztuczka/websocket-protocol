import net from "node:net";
import { randomBytes } from "crypto";

type WebSocketReadyState = "connecting" | "open" | "closing" | "closed";

export class WebSocket {
  private tcpSocket: net.Socket;
  public readyState: WebSocketReadyState;

  constructor() {
    this.readyState = "connecting";

    this.tcpSocket = net.createConnection({
      port: 80,
    });

    this.tcpSocket.on("connect", () => {
      console.log("Opening handshake");
      console.log(this.tcpSocket.readyState);
      this.tcpSocket.setEncoding("utf-8");
      this.tcpSocket.write(
        `GET / HTTP/1.1\r\n` +
          `Host: localhost:80\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${this.generateWebSocketKey()}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`
      );
    });

    this.tcpSocket.on("data", (data) => {
      console.log("Data from server:", data);
    });

    this.tcpSocket.on("error", (error) => {
      throw error;
    });
  }

  private generateWebSocketKey() {
    return randomBytes(16).toString("base64");
  }
}
