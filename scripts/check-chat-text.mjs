import path from "path";
import { ensureTextCheckModels } from "../server/chat-text-model.mjs";
import { TEXT_CONFIRM, TEXT_RULES, textVerdict } from "../server/chat-text-policy.mjs";
import { loadTextModels, scanText } from "../server/chat-text-worker.mjs";
import { readModeration } from "../src/features/chat/moderation.ts";
import { negativeMessage } from "../src/core/runtime/messages.ts";

const texts = process.argv.slice(2);
if (!texts.length) {
  console.error(negativeMessage('usage: bun run check:chat-text "message" ["message"...]'));
  process.exit(1);
}

const root = path.join(import.meta.dir, "..");
const models = await loadTextModels(await ensureTextCheckModels(root));
console.log(`block limits ${TEXT_RULES.map((rule) => `${rule.score} ${rule.limit} -> ${rule.category}`).join(", ")}`);
console.log(`confirm limits ${Object.entries(TEXT_CONFIRM).map(([category, rule]) => `${category} needs ${rule.score} ${rule.limit}`).join(", ")}`);
for (const text of texts) {
  const reading = readModeration(text);
  const { scores } = await scanText(models, text);
  const verdict = textVerdict(reading, scores);
  const margins = Object.entries(scores).map(([score, value]) => `${score} ${value.toFixed(3)}`).join(", ");
  const rule = reading.verdict.allowed ? (reading.suspect ? `rules suspect ${reading.suspect.category}` : "rules pass") : `rules block ${reading.verdict.category}`;
  const cues = [reading.playful && "playful", reading.hyperbole && "hyperbole"].filter(Boolean).join(" ") || "no cues";
  if (verdict.allowed) console.log(`${JSON.stringify(text)}: allowed (${margins}; ${rule}; ${cues})`);
  else console.log(negativeMessage(`${JSON.stringify(text)}: blocked for ${verdict.category}, ${verdict.strikes} strikes (${margins}; ${rule}; ${cues})`));
}
process.exit(0);
