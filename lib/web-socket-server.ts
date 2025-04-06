import EventEmitter from "node:events";
import type { IncomingMessage, Server } from "node:http";

import { WebSocketRequest } from "./web-socket-request.ts";
import type { WebSocketConnection } from "./web-socket-connection.ts";
import type { Socket } from "node:net";

export class WebSocketServer extends EventEmitter {
  private httpServer: Server;
  private connections: WebSocketConnection[] = [];

  constructor(httpServer: Server) {
    super();
    this.httpServer = httpServer;

    this.httpServer.on("upgrade", (req, socket) =>
      this.handleUpgradeRequest(req, socket as Socket),
    );
  }

  private handleUpgradeRequest(req: IncomingMessage, socket: Socket) {
    const wsRequest = new WebSocketRequest(req, socket);

    try {
      wsRequest.readRequest();
    } catch (err) {
      // handle error
      console.log("Read request error");
    }

    const connection = wsRequest.acceptRequest();

    if (!connection) {
      // handle error
      console.log("Connection error");
      return;
    }

    this.emit("connect", connection);
    this.connections.push(connection);
  }
}
