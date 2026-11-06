import fs from "fs";
import net from "net";
import path from "path";
import { NEGATIVE } from "../src/core/runtime/messages.ts";

const CONTROL_MAX_BYTES = 4096;

export function chatSocketPath(root) {
  return process.env.LYRA_CHAT_SOCKET || path.join(root, "cache", "chat", "control.sock");
}

export function serveChatControl(socketPath, control) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let server;
  let owned = false;
  let stopped = false;
  const probe = net.createConnection(socketPath);
  probe.once("connect", () => {
    probe.destroy();
    console.error("chat control socket is already used by another server:", socketPath, NEGATIVE);
  });
  probe.once("error", () => {
    if (stopped) return;
    fs.rmSync(socketPath, { force: true });
    server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let result;
          try {
            result = control(JSON.parse(line));
          } catch {
            result = { error: "that command is not valid" };
          }
          if (!socket.destroyed) socket.write(`${JSON.stringify(result)}\n`);
        }
        if (buffer.length > CONTROL_MAX_BYTES) socket.destroy();
      });
    });
    server.on("error", (error) => console.error("chat control socket failed:", error, NEGATIVE));
    server.listen(socketPath, () => {
      owned = true;
      fs.chmodSync(socketPath, 0o600);
    });
    server.unref();
  });
  return () => {
    stopped = true;
    server?.close();
    if (owned) fs.rmSync(socketPath, { force: true });
  };
}
