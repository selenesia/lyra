import fs from "fs";
import path from "path";
import { createChatImageCheck } from "../server/chat-image-check.mjs";
import { createChatRoom } from "../server/chat.mjs";
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
  throw new Error(negativeMessage(message));
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
const texts = createChatTextCheck({ root });
const smokeStore = createChatStore(":memory:");
const room = createChatRoom({
  store: smokeStore,
  identify: async (request) => ({ id: Number(request.headers.get("x-smoke-user") || 1), username: `smoke${request.headers.get("x-smoke-user") || 1}` }),
  checkImage: checker.check,
  checkText: texts.check,
});
try {
  for (const [sample, type] of SAMPLES) {
    const bytes = fs.readFileSync(path.join(root, sample));
    const form = new globalThis.FormData();
    form.set("channel", "general");
    form.set("text", SAFE_TEXT);
    form.set("image", new Blob([bytes], { type }), "sample");
    const response = await room.handle(new Request("http://localhost/api/chat/message", { method: "POST", body: form }));
    const result = await response.json();
    if (response.status !== 200 || result.message?.attachment?.type !== type) fail("chat attachment upload check failed");
    const mediaUrl = `http://localhost/api/chat/media/message/${result.message.id}`;
    const media = await room.handle(new Request(mediaUrl));
    if (media.status !== 200 || !Buffer.from(await media.arrayBuffer()).equals(bytes)) fail("chat attachment storage check failed");
    const removed = await room.handle(new Request("http://localhost/api/chat/message", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "delete", id: result.message.id }),
    }));
    if (removed.status !== 200 || (await room.handle(new Request(mediaUrl))).status !== 404) fail("chat attachment deletion check failed");
  }
  const unreadable = await checker.check(new Uint8Array(64).fill(7), "image/webp");
  if (!unreadable.invalid) fail("chat image check accepted unreadable bytes");
  for (const [index, text] of ["nigg1er", "i like c*sam"].entries()) {
    const response = await room.handle(new Request("http://localhost/api/chat/message", {
      method: "POST", headers: { "Content-Type": "application/json", "x-smoke-user": String(index + 2) }, body: JSON.stringify({ channel: "general", text }),
    }));
    if (response.status !== 422 || (await response.json()).code !== "CHAT_MESSAGE_BLOCKED") fail("chat text bypass check failed");
  }
  const verdict = async (text) => {
    const scores = await texts.check(text);
    if (!scores) fail("chat text check did not answer");
    return textVerdict(readModeration(text), scores);
  };
  if (!(await verdict(SAFE_TEXT)).allowed) fail("chat text check rejected a safe sample");
  if ((await verdict(CRISIS_TEXT)).category !== "crisis") fail("chat text check missed a self-harm sample");
} finally {
  room.close();
  smokeStore.close();
  checker.close();
  texts.close();
}
console.log(positiveMessage("chat image, text and attachment checks passed"));
process.exit(0);
