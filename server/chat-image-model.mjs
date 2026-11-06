import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { negativeMessage } from "../src/core/runtime/messages.ts";

const CLIP = { repository: "Xenova/mobileclip_s0", revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f", dir: "mobileclip-s0" };

export const IMAGE_MODEL_FILES = {
  vision: { ...CLIP, source: "onnx/vision_model.onnx", name: "vision_model.onnx", sha256: "17d3c037b1d488c10c50e09f6009ea5a198caef4e0e8f4ea5617b7cb2d067ac0" },
  text: { ...CLIP, source: "onnx/text_model_quantized.onnx", name: "text_model_quantized.onnx", sha256: "b8557b10e5c23a0126c6d2e6eba48d240484979007917d128953b31618a04211" },
  tokenizer: { ...CLIP, source: "tokenizer.json", name: "tokenizer.json", sha256: "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85" },
  nsfw: {
    repository: "onnx-community/nsfw-image-detector-ONNX",
    revision: "6626debca038a8f7aa1729b1eaee3bd4eb929ad6",
    dir: "nsfw-image-detector",
    source: "onnx/model_quantized.onnx",
    name: "model_quantized.onnx",
    sha256: "10354606f3442d24308c0a37d1fd6205ab7ce7bf31669e186a4fc5cf7f51b455",
  },
  safety: {
    repository: "OwenElliott/image-safety-classifier-l",
    revision: "f0097d6ca6f684563d9eec9f02b30fa91c694d4c",
    dir: "image-safety-classifier",
    source: "onnx/image-safety-classifier-l.onnx",
    name: "image-safety-classifier-l.onnx",
    sha256: "1430a5ec72b5f81165b19f352c7183765177b91723c4073df302231de3d91ff3",
  },
};

export const IMAGE_EMBEDDER = { input: "pixel_values", output: "image_embeds" };

export const IMAGE_CLASSIFIERS = {
  nsfw: { input: "pixel_values", output: "logits", side: 224, range: [-1, 1], softmax: true, labels: ["drawings", "hentai", "neutral", "porn", "sexy"] },
  safety: { input: "image", output: "probabilities", side: 224, range: [0, 255], softmax: false, labels: ["NSFL", "NSFW", "SFW"] },
};

export const IMAGE_CHECK_MODELS = ["vision", ...Object.keys(IMAGE_CLASSIFIERS)];

export const IMAGE_MODEL_ID = `${CLIP.repository}@${CLIP.revision.slice(0, 7)}`;

export function imageModelPath(root, key) {
  const file = IMAGE_MODEL_FILES[key];
  return path.join(root, "cache", "models", file.dir, file.name);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function ensureImageModelFile(root, key) {
  const file = IMAGE_MODEL_FILES[key];
  const target = imageModelPath(root, key);
  if (fs.existsSync(target)) {
    if ((await sha256(target)) === file.sha256) return target;
    fs.rmSync(target, { force: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(`https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.source}`, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(negativeMessage(`model download returned ${response.status}`));
  const partial = `${target}.${process.pid}.part`;
  try {
    await Bun.write(partial, response);
    if ((await sha256(partial)) !== file.sha256) throw new Error(negativeMessage(`model checksum mismatch for ${file.name}`));
    fs.renameSync(partial, target);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return target;
}

export async function ensureImageCheckModels(root) {
  const paths = await Promise.all(IMAGE_CHECK_MODELS.map((key) => ensureImageModelFile(root, key)));
  return Object.fromEntries(IMAGE_CHECK_MODELS.map((key, index) => [key, paths[index]]));
}
