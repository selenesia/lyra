import fs from "fs";
import path from "path";
import { createChatImageCheck } from "../server/chat-image-check.mjs";
import { ensureImageCheckModels } from "../server/chat-image-model.mjs";
import { chatDatabasePath, createChatStore } from "../server/chat-store.mjs";
import { negativeMessage, positiveMessage } from "../src/core/runtime/messages.ts";

const root = path.join(import.meta.dir, "..");
const SAMPLES = [
  ["src/assets/images/peaks/azu.webp", "image/webp"],
  ["src/assets/images/gifs/oneko.gif", "image/gif"],
];

function fail(message) {
  console.error(negativeMessage(message));
  process.exit(1);
}

const models = await ensureImageCheckModels(root).catch(() => fail("chat image models could not be downloaded"));
console.log(positiveMessage(`chat image models verified (${Object.keys(models).join(", ")})`));

const database = chatDatabasePath(root);
createChatStore(database).close();
for (const file of [database, `${database}-wal`, `${database}-shm`]) if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
console.log(positiveMessage(`chat database ready at ${database.startsWith(`${root}${path.sep}`) ? path.relative(root, database) : database}`));

const checker = createChatImageCheck({ root });
try {
  for (const [sample, type] of SAMPLES) {
    const verdict = await checker.check(fs.readFileSync(path.join(root, sample)), type);
    if (!verdict.allowed) fail(`chat image check rejected a safe sample (${sample})`);
  }
  const unreadable = await checker.check(new Uint8Array(64).fill(7), "image/webp");
  if (!unreadable.invalid) fail("chat image check accepted unreadable bytes");
} finally {
  checker.close();
}
console.log(positiveMessage("chat image checks passed"));
process.exit(0);
