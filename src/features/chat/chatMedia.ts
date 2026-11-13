import { appPath } from "../../core/runtime/hosting.ts";
import { CHAT_ATTACHMENT, CHAT_MEDIA, type ChatAttachmentKind, type ChatMediaKind } from "./chatProtocol.ts";

const QUALITIES = [0.86, 0.74, 0.62, 0.5, 0.4];
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_NAME = /\.(?:mp4|m4v|mov|webm|mkv)$/i;
const AUDIO_NAME = /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const DURATION_READ_MS = 5_000;

export function uploadKind(file: Blob): ChatAttachmentKind | null {
  const name = file instanceof File ? file.name : "";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/") || VIDEO_NAME.test(name)) return "video";
  if (file.type.startsWith("audio/") || AUDIO_NAME.test(name)) return "audio";
  return null;
}

export function readMediaSeconds(file: Blob, kind: "video" | "audio"): Promise<number | null> {
  return new Promise((resolve) => {
    const element = document.createElement(kind);
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (seconds: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(null), DURATION_READ_MS);
    element.preload = "metadata";
    element.muted = true;
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) ? element.duration : null);
    element.onerror = () => finish(null);
    element.src = url;
  });
}

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

async function checkGif(file: Blob, kind: ChatMediaKind | "message"): Promise<ChatImageResult> {
  const limits = (kind === "message" ? CHAT_ATTACHMENT : CHAT_MEDIA[kind]).gif;
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

export async function encodeChatImage(file: Blob, kind: ChatMediaKind | "message"): Promise<ChatImageResult> {
  if (file.type === "image/gif") return checkGif(file, kind);
  if (!file.type.startsWith("image/")) return { error: "unreadable" };
  if (file.size > SOURCE_MAX_BYTES) return { error: "too_large" };
  const image = await drawChatImage(file, kind);
  return image ? { image } : { error: "unreadable" };
}

async function drawChatImage(file: Blob, kind: ChatMediaKind | "message"): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const target = kind === "message" ? CHAT_ATTACHMENT : CHAT_MEDIA[kind];
    const scale = kind === "message"
      ? Math.min(1, target.width / bitmap.width, target.height / bitmap.height)
      : Math.max(target.width / bitmap.width, target.height / bitmap.height);
    const cropWidth = kind === "message" ? bitmap.width : target.width / scale;
    const cropHeight = kind === "message" ? bitmap.height : target.height / scale;
    const width = Math.max(1, Math.round(kind === "message" ? bitmap.width * scale : scale > 1 ? cropWidth : target.width));
    const height = Math.max(1, Math.round(kind === "message" ? bitmap.height * scale : scale > 1 ? cropHeight : target.height));
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
