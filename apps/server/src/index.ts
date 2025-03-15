import { WebSocketServer } from "./web-socket-server.ts";

const server = new WebSocketServer().run();

// server.on("message", () => {
//   console.log("msg arrived");
// });
