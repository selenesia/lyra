import { appPath } from "../../core/runtime/hosting.ts";
import { CHAT_MEDIA, type ChatMediaKind } from "./chatProtocol.ts";

const QUALITIES = [0.86, 0.74, 0.62, 0.5, 0.4];
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;

export function chatMediaUrl(kind: ChatMediaKind, author: string, version: string): string {
  return appPath(`/api/chat/media/${kind}/${encodeURIComponent(author)}?v=${encodeURIComponent(version)}`);
}

function surface(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    return { context: canvas.getContext("2d"), encode: (type: string, quality: number) => canvas.convertToBlob({ type, quality }) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return {
    context: canvas.getContext("2d"),
    encode: (type: string, quality: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)),
  };
}

const COLOR_SAMPLE = 24;
const colorCache = new Map<string, Promise<string | null>>();

async function sampleColor(src: string): Promise<string | null> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const { context } = surface(COLOR_SAMPLE, COLOR_SAMPLE);
  if (!context) return null;
  let data: Uint8ClampedArray;
  try {
    context.drawImage(image, 0, 0, COLOR_SAMPLE, COLOR_SAMPLE);
    data = context.getImageData(0, 0, COLOR_SAMPLE, COLOR_SAMPLE).data;
  } catch {
    return null;
  }
  const buckets = new Map<number, { weight: number; red: number; green: number; blue: number }>();
  let best: { weight: number; red: number; green: number; blue: number } | undefined;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! < 128) continue;
    const red = data[index]!;
    const green = data[index + 1]!;
    const blue = data[index + 2]!;
    const weight = 1 + (Math.max(red, green, blue) - Math.min(red, green, blue)) / 24;
    const key = ((red >> 5) << 6) | ((green >> 5) << 3) | (blue >> 5);
    const bucket = buckets.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 };
    bucket.weight += weight;
    bucket.red += red * weight;
    bucket.green += green * weight;
    bucket.blue += blue * weight;
    buckets.set(key, bucket);
    if (!best || bucket.weight > best.weight) best = bucket;
  }
  if (!best) return null;
  const { weight, red, green, blue } = best;
  return `rgb(${Math.round(red / weight)} ${Math.round(green / weight)} ${Math.round(blue / weight)})`;
}

export function avatarColor(src: string): Promise<string | null> {
  let color = colorCache.get(src);
  if (!color) {
    color = sampleColor(src);
    colorCache.set(src, color);
  }
  return color;
}

export type ChatImageResult = { image: Blob } | { error: "too_large" | "unreadable" };

async function checkGif(file: Blob, kind: ChatMediaKind): Promise<ChatImageResult> {
  const limits = CHAT_MEDIA[kind].gif;
  if (file.size > limits.bytes) return { error: "too_large" };
  try {
    const bitmap = await createImageBitmap(file);
    const fits = bitmap.width <= limits.width && bitmap.height <= limits.height;
    bitmap.close();
    return fits ? { image: file } : { error: "too_large" };
  } catch {
    return { error: "unreadable" };
  }
}

export async function encodeChatImage(file: Blob, kind: ChatMediaKind): Promise<ChatImageResult> {
  if (file.type === "image/gif") return checkGif(file, kind);
  if (!file.type.startsWith("image/")) return { error: "unreadable" };
  if (file.size > SOURCE_MAX_BYTES) return { error: "too_large" };
  const image = await drawChatImage(file, kind);
  return image ? { image } : { error: "unreadable" };
}

async function drawChatImage(file: Blob, kind: ChatMediaKind): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const target = CHAT_MEDIA[kind];
    const scale = Math.max(target.width / bitmap.width, target.height / bitmap.height);
    const cropWidth = target.width / scale;
    const cropHeight = target.height / scale;
    const width = Math.max(1, Math.round(scale > 1 ? cropWidth : target.width));
    const height = Math.max(1, Math.round(scale > 1 ? cropHeight : target.height));
    const { context, encode } = surface(width, height);
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - cropWidth) / 2,
      (bitmap.height - cropHeight) / 2,
      cropWidth,
      cropHeight,
      0,
      0,
      width,
      height,
    );
    for (const type of ["image/webp", "image/jpeg"]) {
      for (const quality of QUALITIES) {
        const blob = await encode(type, quality).catch(() => null);
        if (!blob || blob.type !== type) break;
        if (blob.size <= target.bytes) return blob;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
