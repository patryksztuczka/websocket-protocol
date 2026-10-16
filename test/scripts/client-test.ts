// Talks to the echo server from server-test.ts: start it first with `pnpm server`.
import { WebSocketClient } from "../../lib/web-socket-client.ts";
import type { WebSocketConnection } from "../../lib/web-socket-connection.ts";

const url = process.argv[2] ?? "ws://127.0.0.1:8080/";

const client = new WebSocketClient();

client.on("connect", (connection: WebSocketConnection) => {
  console.log(`Connected to ${url}`);
  let echoes = 0;

  const done = () => {
    echoes++;
    if (echoes < 2) return;
    connection.close();
  };

  connection.on("message", (message) => {
    console.log(`Text echo: ${message.payload}`);
    done();
  });

  connection.on("binaryMessage", (message) => {
    console.log(`Binary echo: ${message.payload.toString("hex")}`);
    done();
  });

  connection.send("text", "Hello world 👋");
  connection.send("binary", Buffer.from([0x00, 0x01, 0xfe, 0xff]));
});

client.on("connectionFailed", (reason) => {
  console.log(`Connection failed: ${reason}`);
  process.exitCode = 1;
});

client.connect(url);
