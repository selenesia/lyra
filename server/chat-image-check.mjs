import os from "os";
import { fileURLToPath } from "url";
import { ensureImageCheckModels } from "./chat-image-model.mjs";
import { imageVerdict, IMAGE_RULES } from "./chat-image-policy.mjs";
import { NEGATIVE, negativeMessage, positiveMessage } from "../src/core/runtime/messages.ts";

const WORKER = fileURLToPath(new URL("./chat-image-worker.mjs", import.meta.url));
const CHECK_TIMEOUT_MS = 45_000;
const IDLE_MS = 5 * 60_000;
const MAX_PENDING = 8;
const RETRY_MS = 60_000;
const WORKER_PRIORITY = 10;
const UNAVAILABLE = { unavailable: true };
const SCORES = IMAGE_RULES.map((rule) => rule.score);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

function verdictFrom(message) {
  if (message.invalid) return { invalid: true };
  if (message.varied) return { varied: true };
  const scores = message.scores;
  if (!scores || !SCORES.every((score) => Number.isFinite(scores[score]))) return UNAVAILABLE;
  return imageVerdict(scores);
}

export function createChatImageCheck({ root, idleMs = IDLE_MS }) {
  const pending = new Map();
  let child;
  let ready = false;
  let loading;
  let idleTimer;
  let failedAt = -Infinity;
  let nextId = 0;

  function stop() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    const current = child;
    child = undefined;
    ready = false;
    loading = undefined;
    current?.kill();
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer);
      resolve(UNAVAILABLE);
    }
    pending.clear();
  }

  function fail(error, { backoff = false } = {}) {
    console.error("chat image checks are unavailable:", error, NEGATIVE);
    if (backoff) failedAt = Date.now();
    stop();
  }

  function idleLater() {
    clearTimeout(idleTimer);
    if (!child || pending.size) return;
    idleTimer = setTimeout(() => pending.size || stop(), idleMs);
    idleTimer.unref?.();
  }

  function settle(message) {
    const job = pending.get(message?.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    job.resolve(verdictFrom(message));
    idleLater();
  }

  async function launch() {
    const models = await ensureImageCheckModels(root);
    let started;
    await new Promise((resolve, reject) => {
      started = Bun.spawn([process.execPath, WORKER], {
        env: {},
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        serialization: "advanced",
        ipc(message) {
          if (message?.type === "ready") resolve();
          else if (message?.type === "failed") reject(new Error(negativeMessage("image model could not load")));
          else settle(message);
        },
        onExit() {
          reject(new Error(negativeMessage("image worker exited before it was ready")));
          if (child === started) fail(new Error(negativeMessage("image worker exited")));
        },
      });
      started.unref();
      child = started;
      try {
        os.setPriority(started.pid, WORKER_PRIORITY);
      } catch {}
      started.send({ type: "start", models });
    });
    if (child !== started) throw new Error(negativeMessage("image worker stopped while loading"));
    ready = true;
    console.log(positiveMessage("chat image checks ready"));
    idleLater();
  }

  function warm() {
    if (!loading && Date.now() - failedAt >= RETRY_MS) loading = launch().catch((error) => fail(error, { backoff: true }));
    return loading;
  }

  async function check(bytes, type) {
    if (pending.size >= MAX_PENDING) return UNAVAILABLE;
    clearTimeout(idleTimer);
    await Promise.race([warm(), delay(CHECK_TIMEOUT_MS)]);
    const target = ready ? child : undefined;
    if (!target) return UNAVAILABLE;
    const id = ++nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(UNAVAILABLE);
        fail(new Error(negativeMessage("image check timed out")));
      }, CHECK_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      target.send({ type: "check", id, bytes, mime: type });
    });
  }

  return { check, warm, close: stop, loaded: () => ready };
}
