import EventEmitter from "node:events";
import type { IncomingMessage, Server } from "node:http";

import { WebSocketRequest } from "./web-socket-request.ts";
import type {
  WebSocketConnection,
  WebSocketConnectionOptions,
} from "./web-socket-connection.ts";
import type { Socket } from "node:net";

export class WebSocketServer extends EventEmitter {
  private httpServer: Server;
  private connections: WebSocketConnection[] = [];
  private connectionOptions: WebSocketConnectionOptions;

  constructor(
    httpServer: Server,
    connectionOptions: WebSocketConnectionOptions = {},
  ) {
    super();
    this.httpServer = httpServer;
    this.connectionOptions = connectionOptions;

    this.httpServer.on("upgrade", (req, socket) =>
      this.handleUpgradeRequest(req, socket as Socket),
    );
  }

  private handleUpgradeRequest(req: IncomingMessage, socket: Socket) {
    const wsRequest = new WebSocketRequest(req, socket, this.connectionOptions);

    try {
      wsRequest.readRequest();
    } catch (error) {
      wsRequest.rejectRequest(error);
      return;
    }

    const connection = wsRequest.acceptRequest();

    this.emit("connect", connection);
    this.connections.push(connection);
  }
}
