import EventEmitter from "node:events";
import type { Socket } from "node:net";

import { WebSocketFrame } from "./web-socket-frame.ts";

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;
  private buffer: Buffer = Buffer.allocUnsafe(0);

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
      console.log("frame not complete - waiting...");
      return;
    }

    console.log("buffer len", this.buffer.length);
    console.log("frame len", frame.toBuffer().length);

    // 4 is number of masking key bytes
    this.buffer = Buffer.from(
      [...this.buffer].slice(frame.toBuffer().length + 4),
    );

    switch (frame.getOpcode()) {
      case 0x0:
        // continuation frame
        break;

      case 0x1:
        this.emit("message", {
          type: "text",
          payload: frame.getBinaryPayload().toString("ascii"),
        });
        break;
      case 0x2:
        // binary frame
        break;
      case 0x8:
        this.emit("end");
        this.sendCloseFrame(1000);
        this.socket.end();
        break;

      case 0x9:
        // ping
        break;

      case 0xa:
        // pong
        break;
    }

    if (this.buffer.length > 0) {
      // TODO: check if this can block other connections processing
      this.processReceivedData();
    }
  }

  private sendCloseFrame(status: number) {
    const closeFrame = new WebSocketFrame();
    closeFrame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0x8)
      .setMasked(0)
      .setStatus(status);

    this.sendFrame(closeFrame);
  }

  private sendFrame(frame: WebSocketFrame) {
    this.socket.write(frame.toBuffer());
  }

  public send(message: string) {
    const frame = new WebSocketFrame();

    frame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0x1)
      .setMasked(0)
      .setMessage(message);

    this.sendFrame(frame);
  }
}
