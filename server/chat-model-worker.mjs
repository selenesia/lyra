import os from "os";
import { NEGATIVE, negativeMessage, positiveMessage } from "../src/core/runtime/messages.ts";

const RETRY_MS = 60_000;
const WORKER_PRIORITY = 10;
export const UNAVAILABLE = { unavailable: true };

export function createModelWorker({ kind, script, models, timeoutMs, idleMs, maxPending }) {
  const pending = new Map();
  let child;
  let ready = false;
  let loading;
  let idleTimer;
  let failedAt = -Infinity;
  let nextId = 0;
  let requests = 0;
  let generation = 0;

  function stop() {
    generation += 1;
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
    console.error(`chat ${kind} checks are unavailable:`, error, NEGATIVE);
    if (backoff) failedAt = Date.now();
    stop();
  }

  function idleLater() {
    clearTimeout(idleTimer);
    if (!child || requests || pending.size) return;
    idleTimer = setTimeout(() => pending.size || stop(), idleMs);
    idleTimer.unref?.();
  }

  function settle(message) {
    const job = pending.get(message?.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    job.resolve(message);
    idleLater();
  }

  async function launch(version) {
    const paths = await models();
    if (version !== generation) return;
    let started;
    await new Promise((resolve, reject) => {
      started = Bun.spawn([process.execPath, script], {
        env: {},
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        serialization: "advanced",
        ipc(message) {
          if (message?.type === "ready") resolve();
          else if (message?.type === "failed") reject(new Error(negativeMessage(`${kind} model could not load`)));
          else settle(message);
        },
        onExit() {
          reject(new Error(negativeMessage(`${kind} worker exited before it was ready`)));
          if (child === started) fail(new Error(negativeMessage(`${kind} worker exited`)));
        },
      });
      started.unref();
      child = started;
      try {
        os.setPriority(started.pid, WORKER_PRIORITY);
      } catch {}
      started.send({ type: "start", models: paths });
    });
    if (child !== started) throw new Error(negativeMessage(`${kind} worker stopped while loading`));
    ready = true;
    console.log(positiveMessage(`chat ${kind} checks ready`));
    idleLater();
  }

  function warm() {
    if (!loading && Date.now() - failedAt >= RETRY_MS) {
      const version = generation;
      loading = launch(version).catch((error) => {
        if (version === generation) fail(error, { backoff: true });
      });
    }
    return loading;
  }

  async function request(message) {
    if (requests >= maxPending) return UNAVAILABLE;
    requests += 1;
    const version = generation;
    let warmTimer;
    try {
      clearTimeout(idleTimer);
      await Promise.race([warm(), new Promise((resolve) => {
        warmTimer = setTimeout(resolve, timeoutMs);
        warmTimer.unref?.();
      })]);
      clearTimeout(warmTimer);
      const target = ready && version === generation ? child : undefined;
      if (!target) return UNAVAILABLE;
      const id = ++nextId;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(UNAVAILABLE);
          fail(new Error(negativeMessage(`${kind} check timed out`)));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        try {
          target.send({ ...message, type: "check", id });
        } catch (error) {
          fail(error, { backoff: true });
        }
      });
    } finally {
      clearTimeout(warmTimer);
      requests -= 1;
      idleLater();
    }
  }

  return { request, warm, close: stop, loaded: () => ready };
}
