import { fileURLToPath } from "url";
import { ensureImageCheckModels } from "./chat-image-model.mjs";
import { imageVerdict, IMAGE_RULES } from "./chat-image-policy.mjs";
import { createModelWorker, UNAVAILABLE } from "./chat-model-worker.mjs";

const WORKER = fileURLToPath(new URL("./chat-image-worker.mjs", import.meta.url));
const CHECK_TIMEOUT_MS = 45_000;
const IDLE_MS = 5 * 60_000;
const MAX_PENDING = 8;
const MAX_CACHED_GIFS = 256;
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
  const gifs = new Map();
  const scan = async (bytes, mime) => verdictFrom(await worker.request({ bytes, mime }));
  function check(bytes, type) {
    if (type !== "image/gif") return scan(bytes, type);
    const key = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    let result = gifs.get(key);
    if (result) {
      gifs.delete(key);
    } else {
      result = scan(bytes, type).catch(() => UNAVAILABLE).then((verdict) => {
        if (typeof verdict.allowed !== "boolean" && gifs.get(key) === result) gifs.delete(key);
        return verdict;
      });
      if (gifs.size >= MAX_CACHED_GIFS) gifs.delete(gifs.keys().next().value);
    }
    gifs.set(key, result);
    return result;
  }
  return {
    check, warm: worker.warm, loaded: worker.loaded,
    close() {
      gifs.clear();
      worker.close();
    },
  };
}
