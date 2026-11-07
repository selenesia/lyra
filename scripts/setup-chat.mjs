import fs from "fs";
import path from "path";
import { createChatImageCheck } from "../server/chat-image-check.mjs";
import { ensureImageCheckModels } from "../server/chat-image-model.mjs";
import { chatDatabasePath, createChatStore } from "../server/chat-store.mjs";
import { createChatTextCheck } from "../server/chat-text-check.mjs";
import { ensureTextCheckModels } from "../server/chat-text-model.mjs";
import { textVerdict } from "../server/chat-text-policy.mjs";
import { readModeration } from "../src/features/chat/moderation.ts";
import { negativeMessage, positiveMessage } from "../src/core/runtime/messages.ts";

const root = path.join(import.meta.dir, "..");
const SAMPLES = [
  ["src/assets/images/peaks/azu.webp", "image/webp"],
  ["src/assets/images/gifs/oneko.gif", "image/gif"],
];
const SAFE_TEXT = "gg everyone, that last round was fun";
const CRISIS_TEXT = "i'm going to jump off the bridge tonight";

function fail(message) {
  console.error(negativeMessage(message));
  process.exit(1);
}

const models = await ensureImageCheckModels(root).catch(() => fail("chat image models could not be downloaded"));
console.log(positiveMessage(`chat image models verified (${Object.keys(models).join(", ")})`));
const textModels = await ensureTextCheckModels(root).catch(() => fail("chat text models could not be downloaded"));
console.log(positiveMessage(`chat text models verified (${Object.keys(textModels).join(", ")})`));

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

const texts = createChatTextCheck({ root });
try {
  const verdict = async (text) => {
    const scores = await texts.check(text);
    if (!scores) fail("chat text check did not answer");
    return textVerdict(readModeration(text), scores);
  };
  if (!(await verdict(SAFE_TEXT)).allowed) fail("chat text check rejected a safe sample");
  if ((await verdict(CRISIS_TEXT)).category !== "crisis") fail("chat text check missed a self-harm sample");
} finally {
  texts.close();
}
console.log(positiveMessage("chat text checks passed"));
process.exit(0);
