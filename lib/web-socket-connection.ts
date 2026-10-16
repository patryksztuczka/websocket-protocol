import EventEmitter from "node:events";
import type { Socket } from "node:net";

import { WebSocketFrame } from "./web-socket-frame.ts";

/** Which end of the connection this is. Clients mask the frames they send, servers don't. */
export type WebSocketRole = "server" | "client";

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;
  private role: WebSocketRole;
  private buffer: Buffer = Buffer.allocUnsafe(0);
  private fragments: WebSocketFrame[] = [];

  constructor(socket: Socket, role: WebSocketRole) {
    super();
    this.socket = socket;
    this.role = role;
  }

  public addSocketEventListeners() {
    this.socket.on("data", this.handleSocketData.bind(this));
    this.socket.on("close", this.handleSocketClose.bind(this));
    this.socket.on("end", this.handleSocketEnd.bind(this));
  }

  private handleSocketData(data: Buffer) {
    this.buffer = Buffer.from([...this.buffer, ...data]);
    this.processReceivedData();
  }

  private handleSocketClose() {
    // TODO: track the closed state (#18)
  }

  private handleSocketEnd() {
    this.socket.end();
  }

  private processReceivedData() {
    const frame = new WebSocketFrame();

    // pause processing if frame data is incomplete
    // frames from a client are masked, frames from a server are not
    if (!frame.addData(this.buffer, this.role === "server")) {
      if (frame.error) {
        this.sendCloseFrame(1002);
      }
      return;
    }

    this.buffer = this.buffer.subarray(frame.getFrameLength());

    switch (frame.getOpcode()) {
      case 0x0:
        if (
          (this.fragments.length === 0 && frame.getFin()) ||
          this.fragments.length === 0
        ) {
          this.sendCloseFrame(1002);
          return;
        }
        this.fragments.push(frame);
        if (frame.getFin()) {
          // make message and emit
          const message = this.combineMessage();
          this.emit("message", {
            type: "text",
            payload: message,
          });
          this.fragments = [];
        }
        break;

      case 0x1:
        if (this.fragments.length !== 0) {
          this.sendCloseFrame(1002);
          return;
        }
        this.fragments.push(frame);
        if (frame.getFin()) {
          // make message and emit

          const message = this.combineMessage();

          this.emit("message", {
            type: "text",
            payload: message,
          });
          this.fragments = [];
        }

        break;
      case 0x2:
        // handle binary frames fragmentation
        this.emit("binaryMessage", {
          type: "binary",
          payload: frame.getBinaryPayload(),
        });
        break;
      case 0x8:
        this.emit("end");
        this.sendCloseFrame(1000);
        break;

      case 0x9:
        this.sendPongFrame(frame.getTextPayload());
        break;

      case 0xa:
        // a pong may arrive unsolicited as a heartbeat and must not be answered (RFC 6455 5.5.3)
        this.emit("pong", frame.getTextPayload());
        break;
    }

    if (this.buffer.length > 0) {
      // TODO: check if this can block other connections processing
      this.processReceivedData();
    }
  }

  private combineMessage(): string {
    // text is UTF-8 (RFC 6455 section 5.6) and a character can be split
    // across fragments, so join the bytes first and decode them once
    const payloads = this.fragments.map((fragment) =>
      fragment.getTextPayload(),
    );

    return Buffer.concat(payloads).toString("utf8");
  }

  private sendCloseFrame(status: number) {
    const closeFrame = new WebSocketFrame();
    closeFrame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0x8)
      .setMasked(0)
      .setStatus(status);

    this.sendFrame(closeFrame, () => {
      this.socket.destroy();
    });
  }

  private sendPongFrame(message: Buffer) {
    const pongFrame = new WebSocketFrame();
    pongFrame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0xa)
      .setMasked(0)
      .setTextPayload(message);
    this.sendFrame(pongFrame);
  }

  private sendFrame(frame: WebSocketFrame, cb?: () => void) {
    this.socket.write(frame.toBuffer(), () => {
      if (cb) cb();
    });
  }

  public send(type: "text" | "binary", message: string | Buffer) {
    const frame = new WebSocketFrame();

    frame.setFin(1).setRsv(0x000).setMasked(0);

    if (type === "text") {
      frame.setOpcode(0x1).setTextPayload(message);
    } else if (type === "binary") {
      frame.setOpcode(0x2).setBinaryPayload(message);
    }

    this.sendFrame(frame);
  }
}
