import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { negativeMessage } from "../src/core/runtime/messages.ts";

export function modelPath(root, file) {
  return path.join(root, "cache", "models", file.dir, file.name);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function ensureModelFile(root, file) {
  const target = modelPath(root, file);
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

export async function ensureModelFiles(root, files, keys) {
  const paths = await Promise.all(keys.map((key) => ensureModelFile(root, files[key])));
  return Object.fromEntries(keys.map((key, index) => [key, paths[index]]));
}
