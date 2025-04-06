import EventEmitter from "node:events";
import type { Socket } from "node:net";

import { WebSocketFrame } from "./web-socket-frame.ts";

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;
  private buffer: Buffer = Buffer.allocUnsafe(0);
  private fragments: WebSocketFrame[] = [];

  constructor(socket: Socket) {
    super();
    this.socket = socket;
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
    // console.log("Socket closed connection", this.socket.closed);
  }

  private handleSocketEnd() {
    this.socket.end();
  }

  private processReceivedData() {
    console.log("new frame");
    const frame = new WebSocketFrame();

    // pause processing if frame data is incomplete
    if (!frame.addData(this.buffer)) {
      console.log("frame not complete or error thrown - waiting...");
      if (frame.error) {
        console.log("ERR", frame.error);
        this.sendCloseFrame(1002);
      }
      return;
    }

    // 4 is number of masking key bytes
    this.buffer = Buffer.from(
      [...this.buffer].slice(frame.toBuffer().length + 4),
    );

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
          console.log("mess", message);
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
        this.sendPingFrame(frame.getTextPayload());
        break;
    }

    if (this.buffer.length > 0) {
      // TODO: check if this can block other connections processing
      this.processReceivedData();
    }
  }

  private combineMessage(): string {
    const fragments = this.fragments;
    const combinedMessage = fragments
      .map((fragment) => fragment.getTextPayload().toString("ascii"))
      .join("");

    return combinedMessage;
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

  private sendPingFrame(message: string) {
    const pingFrame = new WebSocketFrame();
    pingFrame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0x9)
      .setMasked(0)
      .setTextPayload(message);
    this.sendFrame(pingFrame);
  }

  private sendPongFrame(message: string) {
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

  public send(type: "text" | "binary", message: string) {
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
