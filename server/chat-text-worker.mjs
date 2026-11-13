import fs from "fs";
import os from "os";
import * as ort from "onnxruntime-node";
import { TEXT_CLASSIFIERS, TEXT_WINDOW } from "./chat-text-model.mjs";
import { scoreText } from "./chat-text-policy.mjs";
import { createByteLevelTokenizer } from "./chat-text-tokenizer.mjs";
import { NEGATIVE, negativeMessage } from "../src/core/runtime/messages.ts";
import { modelTextVariants } from "../src/features/chat/moderationText.ts";

const THREADS = Math.max(1, Math.min(2, Math.floor(os.availableParallelism() / 2)));
const SESSION_OPTIONS = { intraOpNumThreads: THREADS, interOpNumThreads: 1, executionMode: "sequential", enableCpuMemArena: false };
const HIDDEN = /\p{Cf}+/gu;
let models;

const sigmoid = (value) => 1 / (1 + Math.exp(-value));

function interpolate(value, { x, y }) {
  if (value <= x[0]) return y[0];
  if (value >= x[x.length - 1]) return y[y.length - 1];
  let index = 1;
  while (x[index] < value) index += 1;
  return y[index - 1] + ((value - x[index - 1]) * (y[index] - y[index - 1])) / (x[index] - x[index - 1]);
}

function capToParents(scores, hierarchy) {
  for (const [child, parent] of Object.entries(hierarchy)) scores[child] = Math.min(scores[child], scores[parent]);
}

export function calibrate(odds, calibration) {
  const scores = Object.fromEntries(calibration.categories.map((category, index) => [category, odds[index + 1]]));
  capToParents(scores, calibration.hierarchy);
  for (const category of calibration.categories) scores[category] = interpolate(scores[category], calibration.calibration[category]);
  capToParents(scores, calibration.hierarchy);
  return scores;
}

export function textWindows(ids) {
  const { tokens, stride, windows } = TEXT_WINDOW;
  const parts = [];
  for (let start = 0; parts.length < windows; start += stride) {
    parts.push(ids.slice(start, start + tokens));
    if (start + tokens >= ids.length) break;
  }
  return parts;
}

async function classify(session, spec, ids) {
  const input = [spec.start, ...ids, spec.end];
  const tensor = (values) => new ort.Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);
  const result = await session.run({ input_ids: tensor(input), attention_mask: tensor(input.map(() => 1)) });
  return Array.from(result[spec.output].data, sigmoid);
}

function readCalibration(file) {
  const calibration = JSON.parse(fs.readFileSync(file, "utf8"));
  const usable =
    Array.isArray(calibration.categories) &&
    calibration.labels?.length === calibration.categories.length + 1 &&
    calibration.categories.every((category) => Array.isArray(calibration.calibration?.[category]?.x));
  if (!usable) throw new Error(negativeMessage("text model calibration is not usable"));
  return calibration;
}

export async function loadTextModels(paths) {
  return {
    tokenize: createByteLevelTokenizer(JSON.parse(fs.readFileSync(paths.tokenizer, "utf8"))),
    calibration: readCalibration(paths.calibration),
    moderation: await ort.InferenceSession.create(paths.moderation, SESSION_OPTIONS),
    toxicity: await ort.InferenceSession.create(paths.toxicity, SESSION_OPTIONS),
  };
}

function keepHighest(target, scores) {
  for (const [label, value] of Object.entries(scores)) target[label] = Math.max(target[label] ?? 0, value);
}

async function readText(loaded, text) {
  const readings = { moderation: {}, toxicity: {} };
  const scores = {};
  const { labels } = TEXT_CLASSIFIERS.toxicity;
  for (const ids of textWindows(loaded.tokenize(text.normalize("NFKC").replace(HIDDEN, "")))) {
    const moderation = calibrate(await classify(loaded.moderation, TEXT_CLASSIFIERS.moderation, ids), loaded.calibration);
    const odds = await classify(loaded.toxicity, TEXT_CLASSIFIERS.toxicity, ids);
    const toxicity = Object.fromEntries(labels.map((label, index) => [label, odds[index]]));
    keepHighest(readings.moderation, moderation);
    keepHighest(readings.toxicity, toxicity);
    keepHighest(scores, scoreText({ moderation, toxicity }));
  }
  return { scores, readings };
}

export async function scanText(loaded, text) {
  const readings = { moderation: {}, toxicity: {} };
  const scores = {};
  for (const variant of modelTextVariants(text)) {
    const result = await readText(loaded, variant);
    keepHighest(readings.moderation, result.readings.moderation);
    keepHighest(readings.toxicity, result.readings.toxicity);
    keepHighest(scores, result.scores);
  }
  return { scores, readings };
}

async function check({ id, text }) {
  try {
    const { scores } = await scanText(models, String(text ?? ""));
    process.send({ id, scores });
  } catch (error) {
    console.error("chat text check failed:", error, NEGATIVE);
    process.send({ id, failed: true });
  }
}

if (process.send) {
  let queue = Promise.resolve();
  process.on("disconnect", () => process.exit(0));
  process.on("message", async (data) => {
    if (data?.type === "check") {
      queue = queue.then(() => check(data));
      return;
    }
    if (data?.type !== "start") return;
    try {
      models = await loadTextModels(data.models);
      process.send({ type: "ready" });
    } catch (error) {
      console.error("chat text model could not load:", error, NEGATIVE);
      process.send({ type: "failed" });
    }
  });
}
