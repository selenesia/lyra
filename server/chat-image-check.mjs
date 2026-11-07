import { fileURLToPath } from "url";
import { ensureImageCheckModels } from "./chat-image-model.mjs";
import { imageVerdict, IMAGE_RULES } from "./chat-image-policy.mjs";
import { createModelWorker, UNAVAILABLE } from "./chat-model-worker.mjs";

const WORKER = fileURLToPath(new URL("./chat-image-worker.mjs", import.meta.url));
const CHECK_TIMEOUT_MS = 45_000;
const IDLE_MS = 5 * 60_000;
const MAX_PENDING = 8;
const SCORES = IMAGE_RULES.map((rule) => rule.score);

function verdictFrom(message) {
  if (message.invalid) return { invalid: true };
  if (message.varied) return { varied: true };
  const scores = message.scores;
  if (!scores || !SCORES.every((score) => Number.isFinite(scores[score]))) return UNAVAILABLE;
  return imageVerdict(scores);
}

export function createChatImageCheck({ root, idleMs = IDLE_MS }) {
  const worker = createModelWorker({
    kind: "image",
    script: WORKER,
    models: () => ensureImageCheckModels(root),
    timeoutMs: CHECK_TIMEOUT_MS,
    idleMs,
    maxPending: MAX_PENDING,
  });
  const check = async (bytes, type) => verdictFrom(await worker.request({ bytes, mime: type }));
  return { check, warm: worker.warm, close: worker.close, loaded: worker.loaded };
}
