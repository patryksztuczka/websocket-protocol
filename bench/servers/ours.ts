// Echo server built on this library. Compression stays off, the default, as
// in the ws server, so both do the same work.
import { createServer } from "node:http";

import { WebSocketServer } from "../../lib/web-socket-server.ts";
import { reportToRunner } from "./runner-ipc.ts";

const httpServer = createServer();
const wsServer = new WebSocketServer(httpServer);

wsServer.on("connect", (connection) => {
  connection.addSocketEventListeners();
  connection.on("message", (message) => {
    connection.send("text", message.payload);
  });
  connection.on("binaryMessage", (message) => {
    connection.send("binary", message.payload);
  });
});

httpServer.listen(0, "127.0.0.1", () => reportToRunner(httpServer));
