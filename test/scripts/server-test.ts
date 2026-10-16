import { createServer } from "node:http";

import { WebSocketServer } from "../../lib/web-socket-server.ts";
import type { WebSocketConnection } from "../../lib/web-socket-connection.ts";

// CI sets HOST=0.0.0.0 so the Autobahn container can reach the server on Linux.
const host = process.env["HOST"] ?? "127.0.0.1";

const httpServer = createServer();

httpServer.listen(8080, host, () =>
  console.log(new Date() + ` Server listens on ${host}:8080`),
);

const wsServer = new WebSocketServer(httpServer);

wsServer.on("connect", (connection: WebSocketConnection) => {
  connection.addSocketEventListeners();
  // TODO: improve type-safety for available events
  connection.on("message", (message) => {
    connection.send("text", message.payload);
  });

  connection.on("binaryMessage", (message) => {
    connection.send("binary", message.payload);
  });

  connection.on("end", () => {
    console.log("Client ended connection");
  });
});
