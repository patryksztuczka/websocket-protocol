// Echo server built on ws (https://github.com/websockets/ws), the most used
// WebSocket library for Node. Its optional native add-ons (bufferutil and
// utf-8-validate) are not installed, so it runs on plain JavaScript as this
// library does. Compression is off, ws's default for servers.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { reportToRunner } from "./runner-ipc.ts";

// Bun answers `import "ws"` with its own stand-in for the package, so the
// server loads the package's file by path, which is the real ws on Node and
// on Bun alike
const wsFile = new URL("../../node_modules/ws/wrapper.mjs", import.meta.url);
const { WebSocketServer } = (await import(wsFile.href)) as typeof import("ws");

const httpServer = createServer();
const wsServer = new WebSocketServer({ server: httpServer });

wsServer.on("connection", (socket) => {
  // a client that resets the connection must not crash the server
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    socket.send(data, { binary: isBinary });
  });
});

httpServer.listen(0, "127.0.0.1", () =>
  reportToRunner((httpServer.address() as AddressInfo).port),
);
