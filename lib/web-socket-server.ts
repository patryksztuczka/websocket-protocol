import EventEmitter from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Server as HttpsServer } from "node:https";

import { HandshakeError, WebSocketRequest } from "./web-socket-request.ts";
import type {
  WebSocketConnection,
  WebSocketConnectionOptions,
} from "./web-socket-connection.ts";
import type { Socket } from "node:net";

/** The events the server emits and the arguments their listeners get. */
export interface WebSocketServerEvents {
  /** A handshake passed the checks; answer it with accept() or reject(). */
  request: [request: WebSocketRequest];
  /** A request was accepted and its connection is open. */
  connect: [connection: WebSocketConnection];
}

/**
 * Emits "request" with a WebSocketRequest for every opening handshake that
 * passed the checks of RFC 6455 4.2.1, so the app can accept() or reject() it.
 * Without a "request" listener every such request is accepted. Emits
 * "connect" with the WebSocketConnection of every accepted request.
 */
export class WebSocketServer extends EventEmitter<WebSocketServerEvents> {
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
      // readRequest() only throws HandshakeError; anything else is a bug
      if (!(error instanceof HandshakeError)) throw error;
      wsRequest.reject(error.status, error.message);
      return;
    }

    // the app may answer later, so the connection is added whenever it is
    // accepted rather than right here
    wsRequest.once("accept", (connection) => {
      this.connections.push(connection);
      // forget the connection once it has closed
      socket.once("close", () => {
        this.connections = this.connections.filter((c) => c !== connection);
      });
      // last, so a "connect" listener that throws can't stop the above
      this.emit("connect", connection);
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
