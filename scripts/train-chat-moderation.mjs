import fs from "fs";
import path from "path";
import { buildModerationCorpus, MODERATION_LABELS } from "./chat-moderation/corpus.mjs";
import { featureBuckets, readModerationText } from "../src/features/chat/moderationText.ts";
import { positiveMessage } from "../src/core/runtime/messages.ts";

const BUCKETS = 16384;
const EPOCHS = 40;
const LEARNING_RATE = 0.15;
const L2 = 2e-5;
const HOLDOUT = 0.15;
const THRESHOLDS = { threat: 0.85, self_harm: 0.85, crisis: 0.9, harassment: 0.85, sexual: 0.85, hate: 0.9 };
const OUTPUT = path.join(import.meta.dir, "..", "src", "features", "chat", "moderationModel.ts");

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffle(rows, random) {
  for (let index = rows.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [rows[index], rows[swap]] = [rows[swap], rows[index]];
  }
  return rows;
}

const sigmoid = (value) => 1 / (1 + Math.exp(-value));

function train(rows, label) {
  const weights = new Float64Array(BUCKETS);
  let bias = 0;
  const positives = rows.filter((row) => row.labels[label]).length;
  const positiveWeight = (rows.length - positives) / Math.max(1, positives);
  const random = seeded(7);
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const rate = LEARNING_RATE / (1 + epoch * 0.1);
    for (const row of shuffle([...rows], random)) {
      const target = row.labels[label];
      const score = sigmoid(bias + row.features.reduce((sum, bucket) => sum + weights[bucket], 0));
      const gradient = (score - target) * (target ? positiveWeight : 1);
      bias -= rate * gradient;
      for (const bucket of row.features) {
        weights[bucket] -= rate * (gradient + L2 * weights[bucket]);
      }
    }
  }
  return { weights, bias };
}

function quantize({ weights, bias }, name) {
  const largest = weights.reduce((max, weight) => Math.max(max, Math.abs(weight)), 0) || 1;
  const scale = largest / 127;
  const bytes = new Int8Array(BUCKETS);
  for (let index = 0; index < BUCKETS; index += 1) bytes[index] = Math.round(weights[index] / scale);
  return {
    name,
    bias: Number(bias.toFixed(4)),
    scale: Number(scale.toPrecision(6)),
    threshold: THRESHOLDS[name],
    weights: Buffer.from(bytes.buffer).toString("base64"),
    decoded: Float64Array.from(bytes, (value) => value * Number(scale.toPrecision(6))),
  };
}

function evaluate(rows, label, model) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const row of rows) {
    const score = sigmoid(model.bias + row.features.reduce((sum, bucket) => sum + model.decoded[bucket], 0));
    const predicted = score >= model.threshold;
    if (predicted && row.labels[label]) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (row.labels[label]) falseNegative += 1;
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  return { precision: precision.toFixed(3), recall: recall.toFixed(3), falsePositive };
}

const rows = shuffle(
  buildModerationCorpus().map((row) => ({
    ...row,
    features: featureBuckets(readModerationText(row.text).contentTokens, BUCKETS),
  })),
  seeded(42),
);
const split = Math.floor(rows.length * HOLDOUT);
const holdout = rows.slice(0, split);
const training = rows.slice(split);

for (const label of MODERATION_LABELS) {
  console.log(`${label} holdout`, evaluate(holdout, label, quantize(train(training, label), label)));
}

const final = MODERATION_LABELS.map((label) => quantize(train(rows, label), label));
const source = `export const moderationModel = ${JSON.stringify(
  {
    buckets: BUCKETS,
    labels: final.map(({ name, bias, scale, threshold, weights }) => ({ name, bias, scale, threshold, weights })),
  },
  null,
  2,
)} as const;\n`;
fs.writeFileSync(OUTPUT, source);
console.log(positiveMessage(`trained ${final.length} labels on ${rows.length} rows into ${path.relative(process.cwd(), OUTPUT)}`));
