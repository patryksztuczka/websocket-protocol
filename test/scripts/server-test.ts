import { createServer } from "node:http";

import { WebSocketServer } from "../../lib/web-socket-server.ts";

// CI sets HOST=0.0.0.0 so the Autobahn container can reach the server on Linux.
const host = process.env["HOST"] ?? "127.0.0.1";

const httpServer = createServer();

httpServer.listen(8080, host, () =>
  console.log(new Date() + ` Server listens on ${host}:8080`),
);

const wsServer = new WebSocketServer(httpServer);

// the server and connection events are typed, so the listeners know their
// arguments: a string payload for "message", a Buffer for "binaryMessage"
wsServer.on("connect", (connection) => {
  connection.addSocketEventListeners();
  connection.on("message", (message) => {
    connection.send("text", message.payload);
  });

  connection.on("binaryMessage", (message) => {
    connection.send("binary", message.payload);
  });

  connection.on("close", (code, reason) => {
    console.log(`Connection closed with ${code} ${reason}`);
  });
});
