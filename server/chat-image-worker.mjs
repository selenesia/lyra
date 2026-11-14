import os from "os";
import * as ort from "onnxruntime-node";
import labels from "./chat-image-labels.json" with { type: "json" };
import { CROP_SIDE, ImageTooVaried, ImageUnreadable, planImage, resizeCrops } from "./chat-image-frames.mjs";
import { IMAGE_CLASSIFIERS, IMAGE_EMBEDDER, IMAGE_MODEL_ID } from "./chat-image-model.mjs";
import { IMAGE_COVERAGE, scoreImage } from "./chat-image-policy.mjs";
import { NEGATIVE, negativeMessage } from "../src/core/runtime/messages.ts";

const THREADS = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
const SESSION_OPTIONS = { intraOpNumThreads: THREADS, interOpNumThreads: 1, executionMode: "sequential", enableCpuMemArena: false };
const SCREEN = IMAGE_CLASSIFIERS[IMAGE_COVERAGE.screen];
const CROP_SIZE = 3 * CROP_SIDE * CROP_SIDE;

const quantized = new Int8Array(Uint8Array.from(Buffer.from(labels.weights, "base64")).buffer);
const label = labels.labels.map((entry, row) => ({
  category: entry.category,
  vector: Float32Array.from(quantized.subarray(row * labels.width, (row + 1) * labels.width), (value) => value * entry.scale),
}));
const CLIP_LOGIT_SCALE = 100;
let models;

function shares(similarity, categories) {
  const chosen = label.flatMap(({ category }, index) => (categories.includes(category) ? [index] : []));
  const top = Math.max(...chosen.map((index) => similarity[index]));
  const mass = Object.fromEntries(categories.map((category) => [category, 0]));
  let total = 0;
  for (const index of chosen) {
    const weight = Math.exp(CLIP_LOGIT_SCALE * (similarity[index] - top));
    mass[label[index].category] += weight;
    total += weight;
  }
  for (const category of categories) mass[category] /= total;
  return mass;
}

function average(similarity, category) {
  let sum = 0;
  let count = 0;
  label.forEach((entry, index) => {
    if (entry.category !== category) return;
    sum += similarity[index];
    count += 1;
  });
  return sum / count;
}

export function matchLabels(embedding) {
  const length = Math.hypot(...embedding) || 1;
  const similarity = label.map(({ vector }) => {
    let dot = 0;
    for (let index = 0; index < labels.width; index += 1) dot += vector[index] * embedding[index];
    return dot / length;
  });
  const content = shares(similarity, ["safe", "sexual", "gore"]);
  return {
    sexual: content.sexual,
    gore: content.gore,
    minor: shares(similarity, ["minor", "adult"]).minor,
    hate: average(similarity, "hate") - average(similarity, "safe"),
  };
}

function softmax(row) {
  const top = Math.max(...row);
  const odds = Array.from(row, (value) => Math.exp(value - top));
  const total = odds.reduce((sum, value) => sum + value, 0);
  return odds.map((value) => value / total);
}

export function readClassifier(spec, values) {
  const shares = spec.softmax ? softmax(values) : Array.from(values);
  return Object.fromEntries(spec.labels.map((name, index) => [name, shares[index]]));
}

function toRange(values, [low, high], unit) {
  const input = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) input[index] = low + (values[index] / unit) * (high - low);
  return input;
}

async function run(session, input, output, side, values) {
  const result = await session.run({ [input]: new ort.Tensor("float32", values, [1, 3, side, side]) });
  return result[output].data;
}

export async function loadImageModels(paths) {
  if (labels.model !== IMAGE_MODEL_ID) throw new Error(negativeMessage("image labels were built for another model"));
  const loaded = {};
  for (const [key, file] of Object.entries(paths)) loaded[key] = await ort.InferenceSession.create(file, SESSION_OPTIONS);
  return loaded;
}

async function screenFrames(loaded, plan) {
  const size = 3 * SCREEN.side * SCREEN.side;
  const readings = [];
  for (let crop = 0; crop * size < plan.screen.length; crop += 1) {
    const values = toRange(plan.screen.subarray(crop * size, (crop + 1) * size), SCREEN.range, 255);
    readings.push(readClassifier(SCREEN, await run(loaded[IMAGE_COVERAGE.screen], SCREEN.input, SCREEN.output, SCREEN.side, values)));
  }
  return readings;
}

async function readCrops(loaded, { count, pixels }) {
  const crops = [];
  for (let crop = 0; crop < count; crop += 1) {
    const values = Float32Array.from(pixels.subarray(crop * CROP_SIZE, (crop + 1) * CROP_SIZE), (value) => value / 255);
    const reading = { clip: matchLabels(await run(loaded.vision, IMAGE_EMBEDDER.input, IMAGE_EMBEDDER.output, CROP_SIDE, values)) };
    for (const [key, spec] of Object.entries(IMAGE_CLASSIFIERS)) {
      if (key === IMAGE_COVERAGE.screen) continue;
      const input = toRange(resizeCrops(values, 1, spec.side), spec.range, 1);
      reading[key] = readClassifier(spec, await run(loaded[key], spec.input, spec.output, spec.side, input));
    }
    crops.push(reading);
  }
  return crops;
}

export async function scanImage(loaded, bytes, type) {
  const plan = await planImage(bytes, type, { screenSide: SCREEN.side, screenCrops: IMAGE_COVERAGE.screenCrops });
  const screened = await screenFrames(loaded, plan);
  const wanted = Array.from({ length: plan.frames }, (_, index) => index);
  const crops = await readCrops(loaded, plan.render(wanted));
  crops.forEach((crop, index) => {
    crop[IMAGE_COVERAGE.screen] = screened[wanted[Math.floor(index / plan.boxes)] * plan.boxes + (index % plan.boxes)];
  });
  return { scores: scoreImage(crops, screened), screened: screened.length, checked: crops.length };
}

async function check({ id, bytes, mime }) {
  try {
    const { scores } = await scanImage(models, bytes, mime);
    process.send({ id, scores });
  } catch (error) {
    const outcome = error instanceof ImageUnreadable ? { invalid: true } : error instanceof ImageTooVaried ? { varied: true } : { failed: true };
    if (outcome.failed) console.error("chat image check failed:", error, NEGATIVE);
    process.send({ id, ...outcome });
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
      models = await loadImageModels(data.models);
      process.send({ type: "ready" });
    } catch (error) {
      console.error("chat image model could not load:", error, NEGATIVE);
      process.send({ type: "failed" });
    }
  });
}
