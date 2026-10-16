import EventEmitter from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Server as HttpsServer } from "node:https";

import { WebSocketRequest } from "./web-socket-request.ts";
import type {
  WebSocketConnection,
  WebSocketConnectionOptions,
} from "./web-socket-connection.ts";
import type { Socket } from "node:net";

export class WebSocketServer extends EventEmitter {
  private httpServer: Server | HttpsServer;
  private connections: WebSocketConnection[] = [];
  private connectionOptions: WebSocketConnectionOptions;

  // an https.Server emits the same "upgrade" event, with a TLSSocket, which is a Socket
  constructor(
    httpServer: Server | HttpsServer,
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
    // forget the connection once it has closed
    socket.once("close", () => {
      this.connections = this.connections.filter((c) => c !== connection);
    });
  }
}
