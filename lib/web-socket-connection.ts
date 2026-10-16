import EventEmitter from "node:events";
import type { Socket } from "node:net";

import { ReceiveBuffer } from "./receive-buffer.ts";
import { WebSocketFrame } from "./web-socket-frame.ts";

/** Which end of the connection this is. Clients mask the frames they send, servers don't. */
export type WebSocketRole = "server" | "client";

export interface WebSocketConnectionOptions {
  /**
   * Largest message, in bytes, the connection accepts. A bigger message, or a
   * fragmented message that grows past it, closes the connection with 1009.
   */
  maxMessageSize?: number;
}

/** 64 MiB */
export const DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;
  private role: WebSocketRole;
  private maxMessageSize: number;
  private received = new ReceiveBuffer();
  // the frame being read; it is kept between "data" events until it is complete
  private frame = new WebSocketFrame();
  // payloads of the message being reassembled
  private fragments: Buffer[] = [];
  // payload bytes in `fragments`
  private fragmentsLength = 0;
  // opcode of the message's first frame: 0x1 text or 0x2 binary
  private messageOpcode = 0;

  constructor(
    socket: Socket,
    role: WebSocketRole,
    options: WebSocketConnectionOptions = {},
  ) {
    super();
    this.socket = socket;
    this.role = role;
    this.maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  }

  public addSocketEventListeners() {
    this.socket.on("data", this.handleSocketData.bind(this));
    this.socket.on("close", this.handleSocketClose.bind(this));
    this.socket.on("end", this.handleSocketEnd.bind(this));
  }

  private handleSocketData(data: Buffer) {
    // after a broken frame the rest of the data can't be read, so drop it
    if (this.frame.error) return;
    this.received.push(data);
    this.processReceivedData();
  }

  private handleSocketClose() {
    // TODO: track the closed state (#18)
  }

  private handleSocketEnd() {
    this.socket.end();
  }

  private processReceivedData() {
    // a loop rather than recursion, so many small frames in one chunk can't
    // overflow the stack
    while (true) {
      const frame = this.frame;

      // pause processing if frame data is incomplete
      // frames from a client are masked, frames from a server are not
      if (
        !frame.addData(
          this.received,
          this.role === "server",
          this.maxMessageSize - this.fragmentsLength,
        )
      ) {
        if (frame.error) {
          // nothing more will be read, so let go of the buffered data
          this.received = new ReceiveBuffer();
          this.fragments = [];
          // 1009 when the message is too big (RFC 6455 section 7.4.1)
          this.sendCloseFrame(frame.error === "MESSAGE_TOO_BIG" ? 1009 : 1002);
        }
        return;
      }

      this.frame = new WebSocketFrame();
      const fragmentCount = this.fragments.length;

      switch (frame.getOpcode()) {
        case 0x0:
          // a continuation frame only makes sense while a fragmented message
          // is in progress (RFC 6455 section 5.4)
          if (this.fragments.length === 0) {
            this.sendCloseFrame(1002);
            return;
          }
          this.addFragment(frame.getTextPayload(), frame.getFin());
          break;

        case 0x1:
        case 0x2:
          // a new message can't start before the fragmented one in progress
          // has ended, whatever its type (RFC 6455 section 5.4)
          if (this.fragments.length !== 0) {
            this.sendCloseFrame(1002);
            return;
          }
          this.messageOpcode = frame.getOpcode();
          this.addFragment(
            this.messageOpcode === 0x1
              ? frame.getTextPayload()
              : frame.getBinaryPayload(),
            frame.getFin(),
          );
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

      // keep a running total of the message being reassembled
      if (this.fragments.length === 0) {
        this.fragmentsLength = 0;
      } else if (this.fragments.length > fragmentCount) {
        this.fragmentsLength += frame.getPayloadLength();
      }
    }
  }

  /** Adds a fragment and emits the message once its last fragment arrives. */
  private addFragment(payload: Buffer, fin: number) {
    this.fragments.push(payload);
    if (!fin) return;

    const fragments = this.fragments;
    this.fragments = [];
    // a message sent in one frame needs no copy
    const message =
      fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);

    // the message has the type of its first frame (RFC 6455 section 5.4)
    if (this.messageOpcode === 0x1) {
      // text is UTF-8 (RFC 6455 section 5.6) and a character can be split
      // across fragments, so join the bytes first and decode them once
      this.emit("message", {
        type: "text",
        payload: message.toString("utf8"),
      });
    } else {
      this.emit("binaryMessage", {
        type: "binary",
        payload: message,
      });
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
