import { fileURLToPath } from "url";
import { createModelWorker } from "./chat-model-worker.mjs";
import { ensureTextCheckModels } from "./chat-text-model.mjs";
import { TEXT_SCORES } from "./chat-text-policy.mjs";

const WORKER = fileURLToPath(new URL("./chat-text-worker.mjs", import.meta.url));
const CHECK_TIMEOUT_MS = 10_000;
const IDLE_MS = 15 * 60_000;
const MAX_PENDING = 32;

export function createChatTextCheck({ root, idleMs = IDLE_MS }) {
  const worker = createModelWorker({
    kind: "text",
    script: WORKER,
    models: () => ensureTextCheckModels(root),
    timeoutMs: CHECK_TIMEOUT_MS,
    idleMs,
    maxPending: MAX_PENDING,
  });
  async function check(text) {
    const { scores } = await worker.request({ text });
    return scores && TEXT_SCORES.every((score) => Number.isFinite(scores[score])) ? scores : null;
  }
  return { check, warm: () => void worker.warm(), close: worker.close, loaded: worker.loaded };
}
