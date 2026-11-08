import os from "node:os";
import { negativeMessage, positiveMessage } from "../../src/core/runtime/messages.ts";
import { createIsao } from "./app.ts";

const port = Number.parseInt(process.env.ISAO_PORT || "4003", 10);
const hostname = process.env.ISAO_HOST || "127.0.0.1";
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error(negativeMessage("invalid isao port"));
  process.exit(1);
}

const memoryMb = Math.floor(os.totalmem() / (1024 * 1024));
const isao = createIsao({
  memoryMb,
  upstreamLimit: Math.min(256, Math.max(4, os.availableParallelism() * 2, Math.floor(memoryMb / 512))),
});

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 60,
  fetch: (request) =>
    isao.handle(request).catch((error) => {
      console.error(negativeMessage("isao request failed"), error);
      return Response.json({ error: negativeMessage("isao request failed") }, { status: 500 });
    }),
});

console.log(positiveMessage(`isao listening on ${hostname}:${server.port}`));

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log("shutting down");
  void server.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
