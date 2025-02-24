import net from "node:net";
console.log("Hello from the Client");

const client = net.createConnection({
  port: 80,
});

const dummyVar = 5;
