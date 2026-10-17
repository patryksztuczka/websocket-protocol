// Echo server built on ws (https://github.com/websockets/ws), the most used
// WebSocket library for Node. Its optional native add-ons (bufferutil and
// utf-8-validate) are not installed, so it runs on plain JavaScript as this
// library does. Compression is off, ws's default for servers.
import { createServer } from "node:http";

import { WebSocketServer } from "ws";

import { reportToRunner } from "./runner-ipc.ts";

const httpServer = createServer();
const wsServer = new WebSocketServer({ server: httpServer });

wsServer.on("connection", (socket) => {
  // a client that resets the connection must not crash the server
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    socket.send(data, { binary: isBinary });
  });
});

httpServer.listen(0, "127.0.0.1", () => reportToRunner(httpServer));
