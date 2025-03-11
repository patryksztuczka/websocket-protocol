import { WebSocket } from "./web-socket.ts";

const socket = new WebSocket();

socket.on("open", () => {
  console.log("ws state", socket.readyState);
  socket.send("Hello World!");
});
