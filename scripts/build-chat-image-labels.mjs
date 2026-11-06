import fs from "fs";
import path from "path";
import * as ort from "onnxruntime-node";
import { IMAGE_CONCEPTS, IMAGE_TEMPLATES } from "./chat-moderation/image-labels.mjs";
import { ensureImageModelFile, IMAGE_MODEL_ID } from "../server/chat-image-model.mjs";
import { positiveMessage } from "../src/core/runtime/messages.ts";

const ROOT = path.join(import.meta.dir, "..");
const OUTPUT = path.join(ROOT, "server", "chat-image-labels.json");
const CONTEXT = 77;
const START = 49406;
const END = 49407;
const BATCH = IMAGE_TEMPLATES.length;
const WORD = /'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;

function byteSymbols() {
  const kept = [];
  for (let byte = 33; byte <= 126; byte += 1) kept.push(byte);
  for (let byte = 161; byte <= 172; byte += 1) kept.push(byte);
  for (let byte = 174; byte <= 255; byte += 1) kept.push(byte);
  const symbols = new Map(kept.map((byte) => [byte, String.fromCharCode(byte)]));
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (!symbols.has(byte)) symbols.set(byte, String.fromCharCode(256 + extra++));
  }
  return symbols;
}

function createTokenizer(spec) {
  const vocab = spec.model.vocab;
  const ranks = new Map(spec.model.merges.map((merge, rank) => [merge, rank]));
  const symbols = byteSymbols();
  const encoder = new TextEncoder();
  const bpe = (word) => {
    let parts = [...word];
    parts[parts.length - 1] += "</w>";
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const rank = ranks.get(`${parts[index]} ${parts[index + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = index;
        }
      }
      if (best < 0) return parts.map((part) => vocab[part]);
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
    }
  };
  return (text) => {
    const normal = text.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
    const ids = [START];
    for (const word of normal.match(WORD) ?? []) {
      ids.push(...bpe([...encoder.encode(word)].map((byte) => symbols.get(byte)).join("")));
    }
    const tokens = [...ids.slice(0, CONTEXT - 1), END];
    return [...tokens, ...Array(CONTEXT - tokens.length).fill(0)];
  };
}

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

async function embedTexts(session, tokenize, texts) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    const ids = BigInt64Array.from(batch.flatMap(tokenize).map(BigInt));
    const { text_embeds: embeds } = await session.run({ input_ids: new ort.Tensor("int64", ids, [batch.length, CONTEXT]) });
    const width = embeds.dims[1];
    for (let row = 0; row < batch.length; row += 1) {
      vectors.push(normalize(Array.from(embeds.data.subarray(row * width, (row + 1) * width))));
    }
  }
  return vectors;
}

const tokenize = createTokenizer(JSON.parse(fs.readFileSync(await ensureImageModelFile(ROOT, "tokenizer"), "utf8")));
const session = await ort.InferenceSession.create(await ensureImageModelFile(ROOT, "text"));
const concepts = Object.entries(IMAGE_CONCEPTS).flatMap(([category, list]) => list.map((concept) => ({ category, concept })));
const prompts = concepts.flatMap(({ concept }) => IMAGE_TEMPLATES.map((template) => template.replace("{}", concept)));
const vectors = await embedTexts(session, tokenize, prompts);
const width = vectors[0].length;
const weights = new Int8Array(concepts.length * width);
const labels = concepts.map(({ category, concept }, row) => {
  const mean = normalize(
    Array.from({ length: width }, (_, column) =>
      IMAGE_TEMPLATES.reduce((sum, _, template) => sum + vectors[row * IMAGE_TEMPLATES.length + template][column], 0),
    ),
  );
  const scale = Math.max(...mean.map(Math.abs)) / 127;
  for (let column = 0; column < width; column += 1) weights[row * width + column] = Math.round(mean[column] / scale);
  return { category, concept, scale: Number(scale.toPrecision(6)) };
});
const output = { model: IMAGE_MODEL_ID, width, labels, weights: Buffer.from(weights.buffer).toString("base64") };
fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(positiveMessage(`embedded ${labels.length} image labels into ${path.relative(process.cwd(), OUTPUT)}`));
process.exit(0);
