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
  connection.on("message", (message) => {
    connection.send(message.payload);
  });

  connection.on("end", () => {
    console.log("Client ended connection");
  });
});
