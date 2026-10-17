// Echo server built on Bun.serve, the WebSocket server built into Bun. It is
// native code on top of uWebSockets, not JavaScript, and runs only on Bun.
// Compression is off, Bun's default, as in the other servers.
import { reportToRunner } from "./runner-ipc.ts";

/** The part of Bun's API this server uses; the project has no Bun types. */
declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(
      request: Request,
      server: { upgrade(request: Request): boolean },
    ): Response | undefined;
    websocket: {
      message(
        socket: { send(message: string | Uint8Array): number },
        message: string | Uint8Array,
      ): void;
    };
  }): { port: number };
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return undefined;
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  },
  websocket: {
    // a text message arrives as a string and goes back as text, a binary one
    // as bytes
    message(socket, message) {
      socket.send(message);
    },
  },
});

reportToRunner(server.port);
