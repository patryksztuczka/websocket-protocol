import { WebSocketClient } from "../../lib/web-socket-client.ts";
import type { WebSocketConnection } from "../../lib/web-socket-connection.ts";

const client = new WebSocketClient();

client.connect();

client.on("connect", (connection: WebSocketConnection) => {
  connection.send("Hello world");
});

client.on("connectionFailed", (err) => {
  console.log(err);
});
