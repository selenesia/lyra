import path from "path";
import { ImageTooVaried, ImageUnreadable } from "../server/chat-image-frames.mjs";
import { ensureImageCheckModels } from "../server/chat-image-model.mjs";
import { IMAGE_RULES, imageVerdict } from "../server/chat-image-policy.mjs";
import { loadImageModels, scanImage } from "../server/chat-image-worker.mjs";
import { negativeMessage } from "../src/core/runtime/messages.ts";

const files = process.argv.slice(2);
if (!files.length) {
  console.error(negativeMessage("usage: bun run check:chat-image <image> [image...]"));
  process.exit(1);
}

const root = path.join(import.meta.dir, "..");
const models = await loadImageModels(await ensureImageCheckModels(root));
console.log(`block limits ${IMAGE_RULES.map((rule) => `${rule.score} ${rule.limit} -> ${rule.category}`).join(", ")}`);
for (const file of files) {
  const bytes = await Bun.file(file).bytes();
  try {
    const { scores, screened, checked } = await scanImage(models, bytes, file.toLowerCase().endsWith(".gif") ? "image/gif" : "image/webp");
    const verdict = imageVerdict(scores);
    const margins = Object.entries(scores).map(([score, value]) => `${score} ${value.toFixed(3)}`).join(", ");
    const coverage = `${screened} screened, ${checked} fully checked`;
    if (verdict.allowed) console.log(`${file}: allowed (${margins}, ${coverage})`);
    else console.log(negativeMessage(`${file}: blocked for ${verdict.category} (${margins}, ${coverage})`));
  } catch (error) {
    if (error instanceof ImageUnreadable) console.log(negativeMessage(`${file}: unreadable`));
    else if (error instanceof ImageTooVaried) console.log(negativeMessage(`${file}: too many different frames to check`));
    else throw error;
  }
}
process.exit(0);
