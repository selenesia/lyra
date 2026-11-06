import zlib from "zlib";
import { negativeMessage } from "../src/core/runtime/messages.ts";

export const CROP_SIDE = 256;
const CROP_PIXELS = CROP_SIDE * CROP_SIDE;
const MAX_CROPS_PER_FRAME = 4;
const MAX_DECODED_PIXELS = 512 * 1024 * 1024;
const MAX_STILL_PIXELS = 4096 * 4096;
const THUMB_CELLS = 8;
const NOVELTY = 24;
const PNG_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export class ImageUnreadable extends Error {}
export class ImageTooVaried extends Error {}

function unreadable() {
  return new ImageUnreadable(negativeMessage("image could not be decoded"));
}

function paeth(left, up, corner) {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
}

export function readPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let header;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IHDR") {
      header = {
        width: view.getUint32(offset + 8),
        height: view.getUint32(offset + 12),
        depth: bytes[offset + 16],
        channels: PNG_CHANNELS[bytes[offset + 17]],
        interlaced: bytes[offset + 20] !== 0,
      };
    } else if (type === "IDAT") {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || !header.channels || header.interlaced) throw unreadable();
  const { width, height, channels } = header;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  if (raw.length < height * (stride + 1)) throw unreadable();
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[row + x - channels] : 0;
      const up = y ? rows[row - stride + x] : 0;
      const corner = x >= channels && y ? rows[row - stride + x - channels] : 0;
      const predicted =
        filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;
      rows[row + x] = (raw[source + x] + predicted) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * channels;
    const gray = channels < 3;
    rgba[pixel * 4] = rows[at];
    rgba[pixel * 4 + 1] = gray ? rows[at] : rows[at + 1];
    rgba[pixel * 4 + 2] = gray ? rows[at] : rows[at + 2];
    rgba[pixel * 4 + 3] = channels === 2 ? rows[at + 1] : channels === 4 ? rows[at + 3] : 255;
  }
  return { width, height, rgba };
}

function skipSubBlocks(bytes, offset) {
  while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1;
  return offset + 1;
}

function readSubBlocks(bytes, offset) {
  const parts = [];
  while (offset < bytes.length && bytes[offset] !== 0) {
    parts.push(bytes.subarray(offset + 1, offset + 1 + bytes[offset]));
    offset += bytes[offset] + 1;
  }
  return { data: Buffer.concat(parts), next: offset + 1 };
}

function decodeLzw(data, minCodeSize, pixelCount) {
  const output = new Uint8Array(pixelCount);
  if (minCodeSize < 2 || minCodeSize > 8) throw unreadable();
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let code = 0; code < clear; code += 1) suffix[code] = code;
  let codeSize = minCodeSize + 1;
  let mask = (1 << codeSize) - 1;
  let available = clear + 2;
  let previous = -1;
  let first = 0;
  let bits = 0;
  let datum = 0;
  let read = 0;
  let written = 0;
  while (written < pixelCount) {
    while (bits < codeSize) {
      if (read >= data.length) return output;
      datum |= data[read++] << bits;
      bits += 8;
    }
    let code = datum & mask;
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      mask = (1 << codeSize) - 1;
      available = clear + 2;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) throw unreadable();
      output[written++] = suffix[code];
      previous = code;
      first = code;
      continue;
    }
    if (code > available) throw unreadable();
    const current = code;
    let top = 0;
    if (code === available) {
      stack[top++] = first;
      code = previous;
    }
    while (code > end) {
      stack[top++] = suffix[code];
      code = prefix[code];
      if (top >= 4096) throw unreadable();
    }
    first = suffix[code];
    stack[top++] = first;
    if (available < 4096) {
      prefix[available] = previous;
      suffix[available] = first;
      available += 1;
      if ((available & mask) === 0 && available < 4096) {
        codeSize += 1;
        mask += available;
      }
    }
    previous = current;
    while (top > 0 && written < pixelCount) output[written++] = stack[--top];
  }
  return output;
}

const INTERLACE_PASSES = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
];

function interlacedRows(height) {
  const rows = [];
  for (const [start, step] of INTERLACE_PASSES) for (let row = start; row < height; row += step) rows.push(row);
  return rows;
}

function scanGif(bytes) {
  if (bytes.length < 13) throw unreadable();
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (2 << (bytes[10] & 7));
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      offset = skipSubBlocks(bytes, offset + 1);
    } else if (block === 0x2c) {
      const packed = bytes[offset + 8];
      offset += 9;
      if (packed & 0x80) offset += 3 * (2 << (packed & 7));
      offset = skipSubBlocks(bytes, offset + 1);
      frames += 1;
    } else {
      throw unreadable();
    }
  }
  if (!width || !height || !frames) throw unreadable();
  return { width, height, frames };
}

export function playGif(bytes, onFrame) {
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  let offset = 13;
  let globalPalette = null;
  if (bytes[10] & 0x80) {
    const size = 3 * (2 << (bytes[10] & 7));
    globalPalette = bytes.subarray(offset, offset + size);
    offset += size;
  }
  const canvas = new Uint8Array(width * height * 4);
  let disposal = 0;
  let transparent = -1;
  let index = 0;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (bytes[offset] === 0xf9 && bytes[offset + 1] >= 4) {
        const packed = bytes[offset + 2];
        disposal = (packed >> 2) & 7;
        transparent = packed & 1 ? bytes[offset + 5] : -1;
      }
      offset = skipSubBlocks(bytes, offset + 1);
      continue;
    }
    if (block !== 0x2c) throw unreadable();
    const left = bytes[offset] | (bytes[offset + 1] << 8);
    const top = bytes[offset + 2] | (bytes[offset + 3] << 8);
    const frameWidth = bytes[offset + 4] | (bytes[offset + 5] << 8);
    const frameHeight = bytes[offset + 6] | (bytes[offset + 7] << 8);
    const packed = bytes[offset + 8];
    offset += 9;
    let palette = globalPalette;
    if (packed & 0x80) {
      const size = 3 * (2 << (packed & 7));
      palette = bytes.subarray(offset, offset + size);
      offset += size;
    }
    if (!palette) throw unreadable();
    const minCodeSize = bytes[offset];
    const { data, next } = readSubBlocks(bytes, offset + 1);
    offset = next;
    const indices = decodeLzw(data, minCodeSize, frameWidth * frameHeight);
    const rows = packed & 0x40 ? interlacedRows(frameHeight) : null;
    const saved = disposal === 3 ? canvas.slice() : null;
    for (let row = 0; row < frameHeight; row += 1) {
      const y = top + (rows ? rows[row] : row);
      if (y >= height) continue;
      for (let column = 0; column < frameWidth; column += 1) {
        const x = left + column;
        const colour = indices[row * frameWidth + column];
        if (x >= width || colour === transparent || colour * 3 + 2 >= palette.length) continue;
        const at = (y * width + x) * 4;
        canvas[at] = palette[colour * 3];
        canvas[at + 1] = palette[colour * 3 + 1];
        canvas[at + 2] = palette[colour * 3 + 2];
        canvas[at + 3] = 255;
      }
    }
    onFrame({ width, height, rgba: canvas }, index);
    index += 1;
    if (disposal === 2) {
      for (let y = top; y < Math.min(height, top + frameHeight); y += 1) {
        canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + frameWidth)) * 4);
      }
    } else if (saved) {
      canvas.set(saved);
    }
    disposal = 0;
    transparent = -1;
  }
}

function onWhite(rgba, at, channel) {
  const alpha = rgba[at + 3];
  return (rgba[at + channel] * alpha + 255 * (255 - alpha)) / 255;
}

function thumbnail(frame) {
  const cells = new Float32Array(THUMB_CELLS * THUMB_CELLS * 3);
  const counts = new Uint32Array(THUMB_CELLS * THUMB_CELLS);
  const columns = Int32Array.from({ length: frame.width }, (_, x) => Math.floor((x * THUMB_CELLS) / frame.width));
  for (let y = 0; y < frame.height; y += 1) {
    const row = Math.floor((y * THUMB_CELLS) / frame.height) * THUMB_CELLS;
    for (let x = 0; x < frame.width; x += 1) {
      const cell = row + columns[x];
      const at = (y * frame.width + x) * 4;
      counts[cell] += 1;
      for (let channel = 0; channel < 3; channel += 1) cells[cell * 3 + channel] += onWhite(frame.rgba, at, channel);
    }
  }
  for (let cell = 0; cell < counts.length; cell += 1) {
    for (let channel = 0; channel < 3; channel += 1) cells[cell * 3 + channel] /= counts[cell] || 1;
  }
  return cells;
}

function distance(a, b) {
  let largest = 0;
  for (let cell = 0; cell < a.length; cell += 3) {
    const change = Math.abs(a[cell] - b[cell]) + Math.abs(a[cell + 1] - b[cell + 1]) + Math.abs(a[cell + 2] - b[cell + 2]);
    largest = Math.max(largest, change / 3);
  }
  return largest;
}

export function pickFrames(thumbnails, limit) {
  const picked = [0];
  const nearest = thumbnails.map((thumb) => distance(thumb, thumbnails[0]));
  while (picked.length < limit) {
    let best = -1;
    for (let index = 0; index < nearest.length; index += 1) {
      if (nearest[index] >= NOVELTY && (best < 0 || nearest[index] > nearest[best])) best = index;
    }
    if (best < 0) break;
    picked.push(best);
    for (let index = 0; index < nearest.length; index += 1) {
      nearest[index] = Math.min(nearest[index], distance(thumbnails[index], thumbnails[best]));
    }
  }
  return picked.sort((a, b) => a - b);
}

export function cropBoxes(width, height) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const count = Math.min(MAX_CROPS_PER_FRAME, Math.max(1, Math.round(long / short)));
  const span = long / count;
  return Array.from({ length: count }, (_, index) =>
    width >= height ? { x: index * span, y: 0, width: span, height } : { x: 0, y: index * span, width, height: span },
  );
}

function writeCrop(frame, box, target, slot, side) {
  const plane = side * side;
  const unit = target instanceof Float32Array ? 1 : 255;
  const base = slot * 3 * plane;
  const stepX = box.width / side;
  const stepY = box.height / side;
  for (let outY = 0; outY < side; outY += 1) {
    const fromY = Math.floor(box.y + outY * stepY);
    const toY = Math.max(fromY + 1, Math.min(frame.height, Math.ceil(box.y + (outY + 1) * stepY)));
    for (let outX = 0; outX < side; outX += 1) {
      const fromX = Math.floor(box.x + outX * stepX);
      const toX = Math.max(fromX + 1, Math.min(frame.width, Math.ceil(box.x + (outX + 1) * stepX)));
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let y = fromY; y < toY; y += 1) {
        for (let x = fromX; x < toX; x += 1) {
          const at = (y * frame.width + x) * 4;
          red += onWhite(frame.rgba, at, 0);
          green += onWhite(frame.rgba, at, 1);
          blue += onWhite(frame.rgba, at, 2);
        }
      }
      const scale = (255 * (toY - fromY) * (toX - fromX)) / unit;
      const at = base + outY * side + outX;
      target[at] = red / scale;
      target[at + plane] = green / scale;
      target[at + 2 * plane] = blue / scale;
    }
  }
}

function cropFrames(frames, boxes) {
  const pixels = new Float32Array(frames.length * boxes.length * 3 * CROP_PIXELS);
  let slot = 0;
  for (const frame of frames) for (const box of boxes) writeCrop(frame, box, pixels, slot++, CROP_SIDE);
  return { count: slot, pixels };
}

async function decodeStill(bytes) {
  try {
    const png = await new Bun.Image(bytes, { maxPixels: MAX_STILL_PIXELS }).png({ compressionLevel: 0 }).bytes();
    return readPng(png);
  } catch (error) {
    if (error instanceof ImageUnreadable || typeof error?.code === "string") throw unreadable();
    throw error;
  }
}

function digest(frame) {
  return new Bun.CryptoHasher("sha256").update(frame.rgba).digest("base64");
}

async function planStill(bytes, screenSide) {
  const frame = await decodeStill(bytes);
  const boxes = cropBoxes(frame.width, frame.height);
  const screen = new Uint8ClampedArray(boxes.length * 3 * screenSide * screenSide);
  boxes.forEach((box, slot) => writeCrop(frame, box, screen, slot, screenSide));
  return { boxes: boxes.length, frames: 1, thumbnails: [thumbnail(frame)], screen, render: () => cropFrames([frame], boxes) };
}

function planGif(bytes, screenSide, screenCrops) {
  const { width, height, frames } = scanGif(bytes);
  if (frames * width * height * 2 > MAX_DECODED_PIXELS) throw unreadable();
  const boxes = cropBoxes(width, height);
  const cropSize = 3 * screenSide * screenSide;
  const maxFrames = Math.max(1, Math.floor(screenCrops / boxes.length));
  const screen = new Uint8ClampedArray(Math.min(frames, maxFrames) * boxes.length * cropSize);
  const seen = new Set();
  const playback = [];
  const thumbnails = [];
  playGif(bytes, (frame, index) => {
    const key = digest(frame);
    if (seen.has(key)) return;
    if (playback.length >= maxFrames) throw new ImageTooVaried(negativeMessage("gif has too many different frames to check"));
    seen.add(key);
    boxes.forEach((box, slot) => writeCrop(frame, box, screen, playback.length * boxes.length + slot, screenSide));
    thumbnails.push(thumbnail(frame));
    playback.push(index);
  });
  return {
    boxes: boxes.length,
    frames: playback.length,
    thumbnails,
    screen: screen.subarray(0, playback.length * boxes.length * cropSize),
    render(wanted) {
      const order = new Map(wanted.map((unique, position) => [playback[unique], position]));
      const pixels = new Float32Array(wanted.length * boxes.length * 3 * CROP_PIXELS);
      playGif(bytes, (frame, index) => {
        const position = order.get(index);
        if (position === undefined) return;
        boxes.forEach((box, slot) => writeCrop(frame, box, pixels, position * boxes.length + slot, CROP_SIDE));
      });
      return { count: wanted.length * boxes.length, pixels };
    },
  };
}

export async function planImage(bytes, type, { screenSide, screenCrops }) {
  return type === "image/gif" ? planGif(bytes, screenSide, screenCrops) : planStill(bytes, screenSide);
}

export function resizeCrops(pixels, count, side) {
  const resized = new Float32Array(count * 3 * side * side);
  const scale = CROP_SIDE / side;
  const sample = (at) => {
    const source = Math.min(CROP_SIDE - 1, Math.max(0, (at + 0.5) * scale - 0.5));
    const low = Math.floor(source);
    return { low, high: Math.min(CROP_SIDE - 1, low + 1), weight: source - low };
  };
  const columns = Array.from({ length: side }, (_, x) => sample(x));
  for (let y = 0; y < side; y += 1) {
    const row = sample(y);
    for (let plane = 0; plane < count * 3; plane += 1) {
      const top = plane * CROP_PIXELS + row.low * CROP_SIDE;
      const bottom = plane * CROP_PIXELS + row.high * CROP_SIDE;
      const target = plane * side * side + y * side;
      for (let x = 0; x < side; x += 1) {
        const { low, high, weight } = columns[x];
        const upper = pixels[top + low] + (pixels[top + high] - pixels[top + low]) * weight;
        const lower = pixels[bottom + low] + (pixels[bottom + high] - pixels[bottom + low]) * weight;
        resized[target + x] = upper + (lower - upper) * row.weight;
      }
    }
  }
  return resized;
}
