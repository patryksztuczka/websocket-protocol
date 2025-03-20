import EventEmitter from "node:events";
import http, { type ClientRequest } from "node:http";

export class WebSocketClient extends EventEmitter {
  private _req: ClientRequest | null = null;

  constructor() {
    super();
  }

  public connect() {
    this._req = http.request({
      method: "GET",
      hostname: "127.0.0.1",
      port: 8080,
      path: "/",
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "xyz",
        "sec-websocket-version": "13",
      },
    });

    this._req.end();

    this._req.on("upgrade", (msg) => console.log("upgrade", msg));
    this._req.on("response", (msg) =>
      console.log("response", msg.statusMessage),
    );
    this._req.on("error", (err) => console.log("error:", err));
  }
}
