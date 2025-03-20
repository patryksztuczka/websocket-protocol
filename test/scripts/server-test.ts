import { createServer } from "node:http";

import { WebSocketServer } from "../../lib/web-socket-server.ts";

const httpServer = createServer();

httpServer.listen(8080, "127.0.0.1", () =>
  console.log(new Date() + " Server listens on port 8080"),
);

const wsServer = new WebSocketServer(httpServer);
