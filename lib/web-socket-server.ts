import EventEmitter from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Server as HttpsServer } from "node:https";

import { resolvePerMessageDeflateOptions } from "./permessage-deflate.ts";
import { WebSocketRequest } from "./web-socket-request.ts";
import type {
  WebSocketConnection,
  WebSocketConnectionOptions,
} from "./web-socket-connection.ts";
import type { Socket } from "node:net";

/**
 * Emits "request" with a WebSocketRequest for every opening handshake that
 * passed the checks of RFC 6455 4.2.1, so the app can accept() or reject() it.
 * Without a "request" listener every such request is accepted. Emits
 * "connect" with the WebSocketConnection of every accepted request.
 */
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
    // throws a RangeError right away for invalid compression settings
    resolvePerMessageDeflateOptions(connectionOptions.perMessageDeflate);
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

    // the app may answer later, so the connection is added whenever it is
    // accepted rather than right here
    wsRequest.once("accept", (connection) => {
      this.emit("connect", connection);
      this.connections.push(connection);
      // forget the connection once it has closed
      socket.once("close", () => {
        this.connections = this.connections.filter((c) => c !== connection);
      });
    });

    // apps that don't listen to "request" get every valid request accepted,
    // as before the event existed
    if (this.listenerCount("request") === 0) {
      wsRequest.accept();
      return;
    }

    this.emit("request", wsRequest);
  }
}
