import { ensureModelFiles, modelPath } from "./chat-model-files.mjs";

const MODERATION = { repository: "zgpu-ai/zlm-v1-moderation-edge", revision: "5bc79ed61e7db2ee84b2053a60932db329ae202c", dir: "zlm-moderation-edge" };

const TEXT_MODEL_FILES = {
  moderation: { ...MODERATION, source: "onnx/model_quantized.onnx", name: "model_quantized.onnx", sha256: "2da343dd8212f3d4780b37644ae2c38a950907f411b3926ab8e6e571e4adbf9c" },
  calibration: { ...MODERATION, source: "postprocess.json", name: "postprocess.json", sha256: "7f561d5fff9f6f6b85cdd050bdff9c606d4a730aaa151412f20927b157009386" },
  tokenizer: { ...MODERATION, source: "tokenizer.json", name: "tokenizer.json", sha256: "88d1ffd0a749cd64b6883b6ecd23240dc186be820ebb98924a09ff0b89b8319c" },
  toxicity: {
    repository: "protectai/unbiased-toxic-roberta-onnx",
    revision: "16fd63c0e51000f407fb7d28ce655e41495ebc8b",
    dir: "unbiased-toxic-roberta",
    source: "model_quantized.onnx",
    name: "model_quantized.onnx",
    sha256: "2747e65b2db4071959a2c4c645dd54bf9ff910b4fef66929f5fd450c4976a280",
  },
};

export const TEXT_CLASSIFIERS = {
  moderation: { start: 1, end: 2, output: "logits", calibrated: true },
  toxicity: {
    start: 0,
    end: 2,
    output: "logits",
    calibrated: false,
    labels: ["toxicity", "severe_toxicity", "obscene", "identity_attack", "insult", "threat", "sexual_explicit"],
  },
};

export const TEXT_WINDOW = { tokens: 190, stride: 150, windows: 8 };

export const TEXT_CHECK_MODELS = Object.keys(TEXT_MODEL_FILES);

export function textModelPath(root, key) {
  return modelPath(root, TEXT_MODEL_FILES[key]);
}

export function ensureTextCheckModels(root) {
  return ensureModelFiles(root, TEXT_MODEL_FILES, TEXT_CHECK_MODELS);
}
