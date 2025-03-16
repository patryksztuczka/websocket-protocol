import { WebSocket } from "./web-socket.ts";

const socket = new WebSocket();

socket.run();

socket.on("open", () => {
  socket.send("Hello World!");
});
