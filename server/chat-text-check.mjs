import { fileURLToPath } from "url";
import os from "os";
import { createModelWorker } from "./chat-model-worker.mjs";
import { ensureTextCheckModels } from "./chat-text-model.mjs";
import { TEXT_SCORES } from "./chat-text-policy.mjs";

const WORKER = fileURLToPath(new URL("./chat-text-worker.mjs", import.meta.url));
const CHECK_TIMEOUT_MS = 10_000;
const IDLE_MS = 15 * 60_000;
const MAX_PENDING = 32;

export function createTextCheckQueue(run, { concurrency = 1 } = {}) {
  const jobs = new Map();
  const running = new Set();
  let closed = false;

  function finish(job, scores) {
    jobs.delete(job.text);
    job.resolve(scores);
  }

  async function execute(job) {
    running.add(job);
    try {
      finish(job, await run(job.text));
    } catch {
      finish(job, null);
    } finally {
      running.delete(job);
      drain();
    }
  }

  function drain() {
    while (!closed && running.size < concurrency) {
      const queued = [...jobs.values()].filter((job) => !running.has(job));
      const draftRunning = [...running].some((job) => job.draft);
      const job = queued.find((entry) => !entry.draft) ?? (!draftRunning && queued[0]);
      if (!job) return;
      void execute(job);
    }
  }

  function check(text, { draft = false, userId } = {}) {
    if (closed) return Promise.resolve(null);
    const existing = jobs.get(text);
    if (existing) {
      if (!draft) existing.draft = false;
      else existing.users.add(userId);
      drain();
      return existing.promise;
    }
    if (draft && userId !== undefined) {
      for (const job of jobs.values()) {
        job.users.delete(userId);
        if (!running.has(job) && job.draft && !job.users.size) finish(job, null);
      }
    }
    const queued = [...jobs.values()].filter((job) => !running.has(job) && job.draft === draft);
    if (queued.length >= MAX_PENDING) return Promise.resolve(null);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    jobs.set(text, { text, draft, users: new Set(draft ? [userId] : []), promise, resolve });
    drain();
    return promise;
  }

  return {
    check,
    close() {
      closed = true;
      for (const job of jobs.values()) finish(job, null);
    },
  };
}

export function createChatTextCheck({ root, idleMs = IDLE_MS }) {
  const concurrency = Math.min(2, Math.max(1, Math.floor(os.availableParallelism() / 2)));
  let modelFiles;
  const models = () => {
    if (!modelFiles) {
      modelFiles = ensureTextCheckModels(root).finally(() => { modelFiles = undefined; });
    }
    return modelFiles;
  };
  const workers = Array.from({ length: concurrency }, () => createModelWorker({
    kind: "text",
    script: WORKER,
    models,
    timeoutMs: CHECK_TIMEOUT_MS,
    idleMs,
    maxPending: 1,
  }));
  const busy = new Set();
  const queue = createTextCheckQueue(async (text) => {
    const worker = workers.find((entry) => !busy.has(entry));
    busy.add(worker);
    try {
      const { scores } = await worker.request({ text });
      return scores && TEXT_SCORES.every((score) => Number.isFinite(scores[score])) ? scores : null;
    } finally {
      busy.delete(worker);
    }
  }, { concurrency });
  return {
    check: queue.check,
    warm: () => { for (const worker of workers) void worker.warm(); },
    close() {
      queue.close();
      for (const worker of workers) worker.close();
    },
    loaded: () => workers.some((worker) => worker.loaded()),
  };
}
