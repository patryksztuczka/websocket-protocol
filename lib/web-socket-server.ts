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
    } catch {
      // TODO: reject the handshake instead of carrying on (#14)
    }

    const connection = wsRequest.acceptRequest();

    if (!connection) {
      // TODO: reject the handshake with an HTTP error response (#14)
      return;
    }

    this.emit("connect", connection);
    this.connections.push(connection);
  }
}
