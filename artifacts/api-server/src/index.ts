import { createServer } from "node:http";
import { Server } from "socket.io";
import app from "./app";
import { logger } from "./lib/logger";
import { attachRealtimeHandlers } from "./lib/realtime";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
const io = new Server(server, { path: "/socket.io" });

attachRealtimeHandlers(io);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
