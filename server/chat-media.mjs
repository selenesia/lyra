import { createHash } from "crypto";

const ascii = (bytes, start, text) => Buffer.from(bytes.buffer, bytes.byteOffset + start, text.length).toString("latin1") === text;

function webpSize(bytes) {
  if (bytes.length < 30 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 > bytes.length) return null;
  if (ascii(bytes, 12, "VP8 ")) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (ascii(bytes, 12, "VP8L")) {
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(bytes, 12, "VP8X")) {
    if (bytes[20] & 0x02) return null;
    return {
      width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
      height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
    };
  }
  return null;
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return null;
}

function gifSize(bytes) {
  if (bytes.length < 13 || !(ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) return null;
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

const IMAGE_SIZES = { "image/webp": webpSize, "image/jpeg": jpegSize, "image/gif": gifSize };

export function readChatImage(bytes, type, limits) {
  const size = IMAGE_SIZES[type]?.(bytes) ?? null;
  if (!size || size.width < 1 || size.height < 1 || size.width > limits.width || size.height > limits.height) return null;
  return { type, hash: createHash("sha256").update(bytes).digest("base64url").slice(0, 16), bytes };
}
