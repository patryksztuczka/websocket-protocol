import EventEmitter from "node:events";
import type { Socket } from "node:net";

import { ReceiveBuffer } from "./receive-buffer.ts";
import { Utf8Decoder } from "./utf8-decoder.ts";
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
  // payloads of the binary message being reassembled
  private fragments: Buffer[] = [];
  // decodes and checks the text message being reassembled
  private textDecoder = new Utf8Decoder();
  // payload bytes received so far of the message being reassembled
  private fragmentsLength = 0;
  // opcode of the message's first frame: 0x1 text or 0x2 binary, or 0 when
  // no message is in progress
  private messageOpcode = 0;
  // set once the connection has been failed; nothing more is read after that
  private failed = false;

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
    // after a broken frame or message the rest of the data can't be read, so
    // drop it
    if (this.failed) return;
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
          // 1009 when the message is too big (RFC 6455 section 7.4.1)
          this.failConnection(frame.error === "MESSAGE_TOO_BIG" ? 1009 : 1002);
        }
        return;
      }

      this.frame = new WebSocketFrame();

      switch (frame.getOpcode()) {
        case 0x0:
          // a continuation frame only makes sense while a fragmented message
          // is in progress (RFC 6455 section 5.4)
          if (this.messageOpcode === 0) {
            this.sendCloseFrame(1002);
            return;
          }
          if (!this.addFragment(frame.getTextPayload(), frame.getFin())) return;
          break;

        case 0x1:
        case 0x2:
          // a new message can't start before the fragmented one in progress
          // has ended, whatever its type (RFC 6455 section 5.4)
          if (this.messageOpcode !== 0) {
            this.sendCloseFrame(1002);
            return;
          }
          this.messageOpcode = frame.getOpcode();
          if (
            !this.addFragment(
              this.messageOpcode === 0x1
                ? frame.getTextPayload()
                : frame.getBinaryPayload(),
              frame.getFin(),
            )
          ) {
            return;
          }
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
    }
  }

  /**
   * Adds a fragment and emits the message once its last fragment arrives.
   * Returns false when the text isn't valid UTF-8; the connection has then
   * been failed.
   */
  private addFragment(payload: Buffer, fin: number): boolean {
    this.fragmentsLength += payload.length;

    // the message has the type of its first frame (RFC 6455 section 5.4)
    if (this.messageOpcode === 0x1) {
      // text must be valid UTF-8 (RFC 6455 sections 5.6 and 8.1). Each
      // fragment is checked as it arrives, so a broken message is refused at
      // its first bad fragment. A character can be split across fragments.
      if (!this.textDecoder.write(payload, fin === 1)) {
        this.failConnection(1007);
        return false;
      }
    } else {
      this.fragments.push(payload);
    }

    if (!fin) return true;

    const opcode = this.messageOpcode;
    const fragments = this.fragments;
    this.messageOpcode = 0;
    this.fragments = [];
    this.fragmentsLength = 0;

    if (opcode === 0x1) {
      this.emit("message", {
        type: "text",
        payload: this.textDecoder.end(),
      });
    } else {
      this.emit("binaryMessage", {
        type: "binary",
        // a message sent in one frame needs no copy
        payload:
          fragments.length === 1 ? fragments[0] : Buffer.concat(fragments),
      });
    }
    return true;
  }

  /**
   * Fails the connection (RFC 6455 section 7.1.7): sends a close frame with
   * `status` and stops reading.
   */
  private failConnection(status: number) {
    this.failed = true;
    // nothing more will be read, so let go of the buffered data
    this.received = new ReceiveBuffer();
    this.fragments = [];
    this.sendCloseFrame(status);
  }

  private sendCloseFrame(status: number) {
    const closeFrame = new WebSocketFrame();
    closeFrame.setFin(1).setRsv(0x000).setOpcode(0x8).setStatus(status);

    this.sendFrame(closeFrame, () => {
      this.socket.destroy();
    });
  }

  private sendPongFrame(message: Buffer) {
    const pongFrame = new WebSocketFrame();
    pongFrame.setFin(1).setRsv(0x000).setOpcode(0xa).setTextPayload(message);
    this.sendFrame(pongFrame);
  }

  private sendFrame(frame: WebSocketFrame, cb?: () => void) {
    // every frame a client sends is masked, every frame a server sends is not
    // (RFC 6455 section 5.1)
    frame.setMasked(this.role === "client" ? 1 : 0);
    this.socket.write(frame.toBuffer(), () => {
      if (cb) cb();
    });
  }

  public send(type: "text" | "binary", message: string | Buffer) {
    const frame = new WebSocketFrame();

    frame.setFin(1).setRsv(0x000);

    if (type === "text") {
      frame.setOpcode(0x1).setTextPayload(message);
    } else if (type === "binary") {
      frame.setOpcode(0x2).setBinaryPayload(message);
    }

    this.sendFrame(frame);
  }
}
