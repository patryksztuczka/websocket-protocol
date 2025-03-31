import EventEmitter from "node:events";
import type { Socket } from "node:net";

import { WebSocketFrame } from "./web-socket-frame.ts";

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;
  private buffer: Buffer;
  private currentFrame: WebSocketFrame;
  private fragments: WebSocketFrame[];

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
    this.buffer = data;
    this.processReceivedData();
  }

  private handleSocketClose() {
    // console.log("Socket closed connection", this.socket.closed);
  }

  private handleSocketEnd() {
    this.socket.end();
  }

  private processReceivedData() {
    const frame = new WebSocketFrame();

    this.currentFrame = frame;

    if (!frame.addData(this.buffer)) {
      // handle
      this.sendCloseFrame(1002);
      return;
    }

    switch (frame.opcode) {
      case 0x0:
        // continuation frame
        break;

      case 0x1:
        this.emit("message", {
          type: "text",
          payload: frame.binaryPayload.toString("ascii"),
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
  }

  private sendCloseFrame(status: number) {
    const closeFrame = new WebSocketFrame();
    this.currentFrame = closeFrame;
    closeFrame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0x8)
      .setMasked(0)
      .setStatus(status);

    this.sendFrame(closeFrame);
  }

  private sendFrame(frame: WebSocketFrame) {
    console.log("sending...", frame.binaryPayload);
    this.socket.write(frame.toBuffer());
  }

  public send(message: string) {
    const frame = new WebSocketFrame();

    this.currentFrame = frame;

    frame
      .setFin(1)
      .setRsv(0x000)
      .setOpcode(0x1)
      .setMasked(0)
      .setMessage(message);

    this.sendFrame(frame);
  }
}
