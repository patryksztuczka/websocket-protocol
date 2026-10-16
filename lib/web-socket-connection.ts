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
  /**
   * Milliseconds to wait, once a close frame has been sent, for the closing
   * handshake to finish and the TCP connection to close. After that the
   * socket is destroyed.
   */
  closeTimeout?: number;
}

/** 64 MiB */
export const DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

export const DEFAULT_CLOSE_TIMEOUT = 5000;

/**
 * "open" until a close frame is sent or received, "closing" during the closing
 * handshake and "closed" once the TCP connection has closed.
 */
export type WebSocketReadyState = "open" | "closing" | "closed";

/** Status code reported when the peer's close frame carried no code (RFC 6455 section 7.4.1). */
const NO_STATUS_RECEIVED = 1005;
/** Status code reported when the connection closed without a valid close frame (RFC 6455 section 7.4.1). */
const ABNORMAL_CLOSURE = 1006;

/**
 * Whether an endpoint may put `code` in a close frame: 1000 to 1003 and 1007
 * to 1011 are defined by RFC 6455 section 7.4.1, 3000 to 4999 are for
 * libraries and apps (section 7.4.2). The rest is either reserved or must
 * never be sent, such as 1005 and 1006.
 */
const isValidCloseCode = (code: number) =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1011) ||
  (code >= 3000 && code <= 4999);

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;
  private role: WebSocketRole;
  private maxMessageSize: number;
  private closeTimeout: number;
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
  private state: WebSocketReadyState = "open";
  // set once a close frame has been sent; no other frame may follow it
  private closeSent = false;
  // set once a close frame has been received or the connection has been
  // failed; nothing more is read after that
  private readingStopped = false;
  // code and reason of the peer's close frame, reported in the "close" event
  private closeCode = ABNORMAL_CLOSURE;
  private closeReason = "";
  // destroys the socket if the closing handshake doesn't finish in time
  private closeTimer: NodeJS.Timeout | undefined;
  private listening = false;

  constructor(
    socket: Socket,
    role: WebSocketRole,
    options: WebSocketConnectionOptions = {},
  ) {
    super();
    this.socket = socket;
    this.role = role;
    this.maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
    this.closeTimeout = options.closeTimeout ?? DEFAULT_CLOSE_TIMEOUT;
  }

  public get readyState(): WebSocketReadyState {
    return this.state;
  }

  /**
   * Starts reading from the socket. Server connections need this call; the
   * client makes it by itself right after "connect". Calling it again does
   * nothing, so frames are never read twice.
   */
  public addSocketEventListeners() {
    if (this.listening) return;
    this.listening = true;
    this.socket.on("data", this.handleSocketData.bind(this));
    this.socket.on("close", this.handleSocketClose.bind(this));
    this.socket.on("end", this.handleSocketEnd.bind(this));
    // without a listener a reset by the peer (ECONNRESET, EPIPE) would crash
    // the process. "close" follows the error, so there is nothing else to do.
    this.socket.on("error", () => {});
  }

  private handleSocketData(data: Buffer) {
    // after a close frame, a broken frame or a broken message the rest of
    // the data is not read, so drop it
    if (this.readingStopped) return;
    this.received.push(data);
    this.processReceivedData();
  }

  /**
   * The TCP connection has closed. Emits "close" with the code and reason of
   * the peer's close frame, 1005 if it carried no code, or 1006 if no valid
   * close frame arrived (RFC 6455 sections 7.1.5 and 7.1.6).
   */
  private handleSocketClose() {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.closeTimer);
    this.emit("close", this.closeCode, this.closeReason);
  }

  private handleSocketEnd() {
    // the peer closed its side of the TCP connection, so close ours too
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
            this.failConnection(1002);
            return;
          }
          if (!this.addFragment(frame.getTextPayload(), frame.getFin())) return;
          break;

        case 0x1:
        case 0x2:
          // a new message can't start before the fragmented one in progress
          // has ended, whatever its type (RFC 6455 section 5.4)
          if (this.messageOpcode !== 0) {
            this.failConnection(1002);
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
          // nothing after a close frame is read (RFC 6455 section 5.5.1)
          this.handleCloseFrame(frame.getTextPayload());
          return;

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
   * Answers the peer's close frame (RFC 6455 sections 5.5.1 and 7.1.5). The
   * payload is empty, or a 2-byte status code followed by a UTF-8 reason.
   */
  private handleCloseFrame(payload: Buffer) {
    if (payload.length === 1) {
      // too short to hold a status code
      this.failConnection(1002);
      return;
    }

    let code = NO_STATUS_RECEIVED;
    let reason = "";
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) {
        this.failConnection(1002);
        return;
      }
      // the reason must be valid UTF-8 (RFC 6455 sections 5.5.1 and 8.1)
      const decoder = new Utf8Decoder();
      if (!decoder.write(payload.subarray(2), true)) {
        this.failConnection(1007);
        return;
      }
      reason = decoder.end();
    }

    this.closeCode = code;
    this.closeReason = reason;
    this.stopReading();

    // answer with the same code, or with an empty close frame when there was
    // none. When this side started the closing handshake, the peer's close
    // frame is the answer and nothing more is sent.
    if (!this.closeSent) {
      this.sendCloseFrame(code === NO_STATUS_RECEIVED ? undefined : code);
    }

    // both close frames have been exchanged. The server closes the TCP
    // connection first, the client waits for it (RFC 6455 section 7.1.1); the
    // close timer covers a peer that never does.
    if (this.role === "server") this.socket.end();
  }

  /**
   * Starts the closing handshake: sends a close frame with `code` and
   * `reason` and waits for the peer's close frame. Once the peer has
   * answered, the server closes the TCP connection; if it doesn't answer
   * within `closeTimeout` the socket is destroyed. Does nothing if the
   * connection is already closing or closed.
   *
   * `code` must be 1000 to 1003, 1007 to 1011 or 3000 to 4999 and `reason` at
   * most 123 bytes as UTF-8 (RFC 6455 sections 5.5 and 7.4), otherwise this
   * throws a RangeError.
   */
  public close(code = 1000, reason = "") {
    if (!isValidCloseCode(code)) {
      throw new RangeError(`Close code ${code} can't be sent`);
    }
    // a control frame payload is at most 125 bytes, 2 of them the code
    if (Buffer.byteLength(reason) > 123) {
      throw new RangeError("Close reason is longer than 123 bytes");
    }
    if (this.state !== "open") return;
    this.sendCloseFrame(code, reason);
  }

  /**
   * Fails the connection (RFC 6455 section 7.1.7): sends a close frame with
   * `status`, unless one was already sent, stops reading and closes the TCP
   * connection.
   */
  private failConnection(status: number) {
    this.stopReading();
    if (!this.closeSent) this.sendCloseFrame(status);
    this.socket.end();
  }

  private stopReading() {
    this.readingStopped = true;
    // nothing more will be read, so let go of the buffered data
    this.received = new ReceiveBuffer();
    this.fragments = [];
  }

  /**
   * Sends a close frame. Leaving out `code` sends an empty one. The
   * connection then enters "closing" and the close timer starts.
   */
  private sendCloseFrame(code?: number, reason = "") {
    if (this.closeSent) return;

    let payload = Buffer.alloc(0);
    if (code !== undefined) {
      const reasonBytes = Buffer.from(reason);
      payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
    }

    const closeFrame = new WebSocketFrame();
    closeFrame.setFin(1).setRsv(0x000).setOpcode(0x8).setTextPayload(payload);
    this.sendFrame(closeFrame);

    // the close frame is the last frame this side sends (RFC 6455 section 5.5.1)
    this.closeSent = true;
    if (this.state === "open") this.state = "closing";

    this.closeTimer = setTimeout(
      () => this.socket.destroy(),
      this.closeTimeout,
    );
    // a pending close doesn't keep the process alive
    this.closeTimer.unref();
  }

  private sendPongFrame(message: Buffer) {
    const pongFrame = new WebSocketFrame();
    pongFrame.setFin(1).setRsv(0x000).setOpcode(0xa).setTextPayload(message);
    this.sendFrame(pongFrame);
  }

  private sendFrame(frame: WebSocketFrame) {
    // nothing may follow a close frame (RFC 6455 section 5.5.1), and a
    // closed socket can't be written to
    if (this.closeSent || !this.socket.writable) return;
    // every frame a client sends is masked, every frame a server sends is not
    // (RFC 6455 section 5.1)
    frame.setMasked(this.role === "client" ? 1 : 0);
    this.socket.write(frame.toBuffer());
  }

  /**
   * Sends a message. Once the connection is closing or closed the message is
   * silently dropped, since nothing may be sent after a close frame (RFC 6455
   * section 5.5.1).
   */
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
