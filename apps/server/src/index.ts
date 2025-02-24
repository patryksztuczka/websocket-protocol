import net from "node:net";

console.log("Hello from the Server");

const PORT = 80;

const server = net.createServer((socket) => {
  console.log("New connection", socket.remoteAddress);
});

server.on("error", (error) => {
  throw error;
});

server.listen(PORT, undefined, undefined, () => {
  console.log(`TCP Server running on port ${PORT}`);
});
