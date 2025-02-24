import net from "node:net";
import { createHash } from "crypto";

console.log("Hello from the Server");

const PORT = 80;

const STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const server = net.createServer((socket) => {
  console.log("New connection", socket.remoteAddress);

  socket.on("data", (data) => {
    console.log("data from client:", data.toLocaleString().split("\r\n"));
    const handshake = data.toLocaleString().split("\r\n");
    let isGetRequest = false;
    let isHost = false;
    let isProtocolUpgrade = false;
    let isConnectionUpgrade = false;
    let isWebSocketKey = false;
    let webSocketKey = null;
    let isWebSocketVersion = false;

    for (const line of handshake) {
      if (!isGetRequest && line.slice(0, 3) === "GET") {
        console.log("yass");
        const parts = line.split(" ");
        console.log(parts);
        if (parts[1] !== "/" || parts[2] !== "HTTP/1.1") return;
        isGetRequest = true;
      } else if (!isHost && line.slice(0, 5) === "Host:") {
        console.log(line.slice(5, line.length).trim());
        isHost = true;
      } else if (!isProtocolUpgrade && line.slice(0, 8) === "Upgrade:") {
        console.log(line.slice(8, line.length).trim());
        isProtocolUpgrade = true;
      } else if (!isConnectionUpgrade && line.slice(0, 11) === "Connection:") {
        console.log(line.slice(11, line.length).trim());
        isConnectionUpgrade = true;
      } else if (
        !isWebSocketKey &&
        line.slice(0, 18) === "Sec-WebSocket-Key:"
      ) {
        console.log(line.slice(18, line.length).trim());
        webSocketKey = line.slice(18, line.length).trim();
        isWebSocketKey = true;
      } else if (
        !isWebSocketVersion &&
        line.slice(0, 22) === "Sec-WebSocket-Version:"
      ) {
        console.log(line.slice(22, line.length).trim());
        isWebSocketVersion = true;
      }
    }

    if (
      isGetRequest &&
      isHost &&
      isProtocolUpgrade &&
      isConnectionUpgrade &&
      isWebSocketKey &&
      isWebSocketVersion
    ) {
      const webSocketAccpet = webSocketKey + STRING;

      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${createHash("sha1").update(webSocketAccpet).digest("base64")}\r\n` +
          `\r\n`
      );
    }
  });
});

server.on("error", (error) => {
  throw error;
});

server.listen(PORT, undefined, undefined, () => {
  console.log(`TCP Server running on port ${PORT}`);
});
