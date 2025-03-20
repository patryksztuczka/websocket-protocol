import EventEmitter from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export class WebSocketServer extends EventEmitter {
  public httpServer: Server;

  constructor(httpServer: Server) {
    super();
    this.httpServer = httpServer;

    this.httpServer.on("upgrade", (req, socket) =>
      this.handleUpgradeRequest(req, socket),
    );
  }

  private handleUpgradeRequest(req: IncomingMessage, socket: Duplex) {
    console.log("UPGRADE", req.headers);
  }
}
