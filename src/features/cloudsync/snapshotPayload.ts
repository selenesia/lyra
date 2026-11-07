import { chunkId, manifestSeal, type SyncBytes, type SyncKeys } from "./syncCrypto.ts";
import { hashText, snapshotIndex, type SnapshotIndex } from "./syncMerge.ts";
import type { SyncSnapshot } from "./snapshotSchema.ts";

const SEALED_CHUNK_LIMIT = 1024 * 1024 - 4096;
const MIN_CHUNK = 256 * 1024;
const AVERAGE_CHUNK = 512 * 1024;
const STRICT_MASK = 0xfffff800;
const LOOSE_MASK = 0xffff8000;
const GEAR = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let index = 0; index < table.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    table[index] = state >>> 0;
  }
  return table;
})();

export interface SnapshotChunk {
  id: string;
  offset: number;
  length: number;
}

export interface SnapshotPayload {
  body: Blob;
  fingerprint: string;
  index?: SnapshotIndex | undefined;
  sealed?: { chunks: SnapshotChunk[]; seal: string };
}

async function bytesFingerprint(
  bytes: SyncBytes,
  payload: string,
): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  }
  return hashText(payload);
}

export function payloadFingerprint(payload: string): Promise<string> {
  return bytesFingerprint(new TextEncoder().encode(payload), payload);
}

export function contentBoundaries(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = Math.min(bytes.length, start + SEALED_CHUNK_LIMIT);
    let cut = end;
    if (end - start > MIN_CHUNK) {
      const normal = Math.min(end, start + AVERAGE_CHUNK);
      let hash = 0;
      let index = start + MIN_CHUNK;
      for (; index < normal && cut === end; index++) {
        hash = ((hash << 1) + GEAR[bytes[index]!]!) >>> 0;
        if (!(hash & STRICT_MASK)) cut = index + 1;
      }
      for (; index < end && cut === end; index++) {
        hash = ((hash << 1) + GEAR[bytes[index]!]!) >>> 0;
        if (!(hash & LOOSE_MASK)) cut = index + 1;
      }
    }
    ends.push(cut);
    start = cut;
  }
  return ends;
}

function indexOf(snapshot: unknown): SnapshotIndex | undefined {
  try {
    return snapshotIndex(snapshot as SyncSnapshot);
  } catch {
    return undefined;
  }
}

export async function snapshotPayload(
  snapshot: unknown,
  keys?: SyncKeys | null,
): Promise<SnapshotPayload> {
  const json = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(json);
  const fingerprint = await bytesFingerprint(bytes, json);
  const index = indexOf(snapshot);
  if (!keys) return { body: new Blob([bytes]), fingerprint, index };
  const chunks: SnapshotChunk[] = [];
  let offset = 0;
  for (const end of contentBoundaries(bytes)) {
    chunks.push({
      id: await chunkId(keys, bytes.subarray(offset, end)),
      offset,
      length: end - offset,
    });
    offset = end;
  }
  return {
    body: new Blob([bytes]),
    fingerprint,
    index,
    sealed: {
      chunks,
      seal: await manifestSeal(
        keys,
        chunks.map((chunk) => chunk.id),
      ),
    },
  };
}
