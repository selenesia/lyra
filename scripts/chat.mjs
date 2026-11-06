import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatRoom } from "../server/chat.mjs";
import { chatSocketPath } from "../server/chat-control.mjs";
import { chatDatabasePath, createChatStore, PERMANENT } from "../server/chat-store.mjs";
import { CHAT_ROLES } from "../src/features/chat/chatRoles.ts";
import { NEGATIVE, POSITIVE } from "../src/core/runtime/messages.ts";

const USAGE = `usage:
  bun run chat role <username> <${CHAT_ROLES.join("|")}>   give someone a chat role
  bun run chat timeout <username> <10m|2h|1d|1w>        stop someone from talking for a while
  bun run chat untimeout <username>                     lift a timeout
  bun run chat ban <username> [--for 1d] [--reason "spam"] [--purge]
                                                        ban someone, forever unless --for is given,
                                                        --purge also deletes their last 24h of messages
  bun run chat unban <username>                         lift a ban
  bun run chat user <username>                          show someone's role, timeout, and ban
  bun run chat staff                                    list everyone with a role
  bun run chat audit [count]                            show recent moderation actions

usernames are cloudsync usernames, and the person needs to have opened chat once.`;

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message) {
  console.error(`${message}${NEGATIVE}`);
  process.exit(1);
}

function minutes(value) {
  const match = /^(\d+)(m|h|d|w)$/.exec(value ?? "");
  if (!match) fail(`durations look like 10m, 2h, 1d, or 1w, not "${value ?? ""}"`);
  return Number(match[1]) * { m: 1, h: 60, d: 1_440, w: 10_080 }[match[2]];
}

function parse(args) {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (action === "staff") return { action };
  if (action === "audit") return { action, limit: Number(rest[0]) || 20 };
  const [username, ...options] = rest;
  if (!username) fail(`${action} needs a username`);
  const command = { action, username };
  if (action === "role") {
    if (!CHAT_ROLES.includes(options[0])) fail(`pick one of ${CHAT_ROLES.join(", ")}`);
    command.role = options[0];
  } else if (action === "timeout") {
    command.minutes = minutes(options[0]);
  } else if (action === "ban") {
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      if (option === "--for") command.minutes = minutes(options[++index]);
      else if (option === "--reason") command.reason = options[++index];
      else if (option === "--purge") command.purge = true;
      else fail(`unknown option ${option}`);
    }
  } else if (!["untimeout", "unban", "user"].includes(action)) {
    console.error(USAGE);
    fail(`unknown command ${action}`);
  }
  return command;
}

function viaSocket(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(chatSocketPath(root));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch {
        reject(new Error("bad reply"));
      }
    });
  });
}

function directly(command) {
  const store = createChatStore(chatDatabasePath(root));
  try {
    return createChatRoom({ store, identify: async () => null }).control(command);
  } finally {
    store.close();
  }
}

const when = (time) => (time >= PERMANENT ? "forever" : new Date(time).toLocaleString());

function printUser(user) {
  const parts = [`${user.username} (#${user.id})`, user.role];
  if (user.mutedUntil) parts.push(`timed out until ${when(user.mutedUntil)}`);
  if (user.bannedUntil) parts.push(`banned until ${when(user.bannedUntil)}${user.banReason ? `: ${user.banReason}` : ""}`);
  console.log(parts.join(" · "));
}

const command = parse(process.argv.slice(2));
let result;
try {
  result = await viaSocket(command);
} catch {
  console.log("the server is not running, so this goes straight to the chat database");
  result = directly(command);
}
if (result.error) fail(result.error);

if (command.action === "staff") {
  if (!result.users.length) console.log("nobody has a role yet");
  for (const user of result.users) printUser(user);
} else if (command.action === "audit") {
  if (!result.entries.length) console.log("no moderation actions yet");
  for (const entry of result.entries.reverse()) {
    const actor = entry.actor_name ?? "server";
    const detail = entry.detail ? ` (${entry.detail})` : "";
    console.log(`${new Date(entry.at).toLocaleString()}  ${actor} ${entry.action} ${entry.target_name ?? ""}${detail}`);
  }
} else {
  printUser(result.user);
  if (command.action !== "user") {
    const removed = result.removed ? `, removed ${result.removed} messages` : "";
    console.log(`done${removed}${POSITIVE}`);
  }
}
