import { createServer } from "node:http";

import { WebSocketServer } from "../../lib/web-socket-server.ts";
import type { WebSocketConnection } from "../../lib/web-socket-connection.ts";

const httpServer = createServer();

httpServer.listen(8080, "127.0.0.1", () =>
  console.log(new Date() + " Server listens on port 8080"),
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
