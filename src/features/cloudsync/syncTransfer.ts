import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  openChunk,
  sealChunk,
  verifyManifestSeal,
  type SyncKeys,
} from "./syncCrypto.ts";
import type { SnapshotChunk } from "./snapshotPayload.ts";

const CHUNK_SIZE = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 80 * CHUNK_SIZE;
const MAX_PARTS = MAX_SNAPSHOT_BYTES / CHUNK_SIZE;
const MAX_SEALED_PARTS = 4096;
const MAX_CONCURRENCY = 8;
const REQUEST_TIMEOUT = 60_000;
const TRANSFER_TIMEOUT = 5 * 60_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface TransferOptions {
  base?: string | null;
}

export interface SealedSnapshot {
  chunks: SnapshotChunk[];
  seal: string;
}

function remaining(deadline: number): number {
  const budget = deadline - Date.now();
  if (budget <= 0) throw new Error(negativeMessage("sync transfer timed out"));
  return budget;
}

function concurrency(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), MAX_CONCURRENCY)
    : 1;
}

function tooLarge(): Response {
  return Response.json(
    {
      code: "sync_payload_too_large",
      error: negativeMessage("sync payload is too large"),
    },
    { status: 413 },
  );
}

function sealedFailure(code: string, message: string): Response {
  return Response.json(
    { code, error: negativeMessage(message) },
    { status: 423 },
  );
}

async function request(
  url: string,
  deadline: number,
  options: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(REQUEST_TIMEOUT, remaining(deadline)),
    );
    let retryAfter = 0;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
      });
      const body = await response.blob();
      remaining(deadline);
      if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      }
      const header = response.headers.get("retry-after");
      const seconds = Number(header);
      retryAfter = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : Math.max(0, Date.parse(header || "") - Date.now()) || 0;
    } catch {
      remaining(deadline);
      if (attempt === 3)
        throw new Error(negativeMessage("sync connection failed"));
    } finally {
      clearTimeout(timer);
    }
    const delay = Math.max(retryAfter, 500 * 2 ** attempt + Math.random() * 500);
    if (delay >= remaining(deadline))
      throw new Error(negativeMessage("sync transfer timed out"));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function transferParts(
  parts: number[],
  allowance: number,
  transfer: (part: number) => Promise<Response>,
): Promise<Response | null> {
  let next = 0;
  let stopped = false;
  let failure: Response | null = null;
  const workers = Array.from(
    { length: Math.min(allowance, parts.length) },
    async () => {
      while (!stopped && next < parts.length) {
        const part = parts[next++]!;
        try {
          const response = await transfer(part);
          if (!response.ok) {
            failure ??= response;
            stopped = true;
          }
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  const results = await Promise.allSettled(workers);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return failure;
}

function commitRequest(
  id: string,
  deadline: number,
  options: TransferOptions,
  seal?: string,
): Promise<Response> {
  const body: Record<string, string> = {};
  if (options.base !== undefined) body.base = options.base ?? "";
  if (seal !== undefined) body.seal = seal;
  return request(`/api/sync/transfer/${id}/commit`, deadline, {
    method: "POST",
    ...(Object.keys(body).length
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

function validMissing(missing: unknown, parts: number): boolean {
  return (
    missing === undefined ||
    (Array.isArray(missing) &&
      missing.every(
        (part: unknown) =>
          Number.isSafeInteger(part) && Number(part) >= 0 && Number(part) < parts,
      ) &&
      new Set(missing).size === missing.length)
  );
}

export async function uploadSnapshot(
  body: string | Blob,
  options: TransferOptions = {},
): Promise<Response> {
  const deadline = Date.now() + TRANSFER_TIMEOUT;
  const snapshot = typeof body === "string" ? new Blob([body]) : body;
  if (!snapshot.size || snapshot.size > MAX_SNAPSHOT_BYTES) return tooLarge();
  const parts = Math.ceil(snapshot.size / CHUNK_SIZE);
  const indexes = Array.from({ length: parts }, (_, part) => part);
  const hashes: string[] | undefined = globalThis.crypto?.subtle ? [] : undefined;
  if (hashes) {
    for (const part of indexes) {
      remaining(deadline);
      const bytes = await snapshot.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      hashes.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    }
  }
  const started = await request("/api/sync/transfer", deadline, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts, ...(hashes ? { hashes } : {}) }),
  });
  if (!started.ok) return started;
  const { id, chunk_size, missing, concurrency: allowance, max_bytes } = await started.json();
  if (
    typeof id !== "string" ||
    !UPLOAD_ID_PATTERN.test(id) ||
    chunk_size !== CHUNK_SIZE ||
    (max_bytes !== undefined && (!Number.isSafeInteger(max_bytes) || snapshot.size > max_bytes)) ||
    !validMissing(missing, parts)
  ) {
    throw new Error(negativeMessage("sync transfer is unavailable"));
  }
  const failure = await transferParts(missing ?? indexes, concurrency(allowance), async (part) => {
    remaining(deadline);
    let chunk = snapshot.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (typeof CompressionStream !== "undefined") {
      const compressed = await new Response(
        chunk.stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      if (compressed.size < chunk.size) {
        chunk = compressed;
        headers["Content-Encoding"] = "gzip";
      }
    }
    return request(`/api/sync/transfer/${id}/${part}`, deadline, {
      method: "PUT",
      headers,
      body: chunk,
    });
  });
  if (failure) return failure;
  return commitRequest(id, deadline, options);
}

export async function uploadSealedSnapshot(
  body: Blob,
  sealed: SealedSnapshot,
  keys: SyncKeys,
  options: TransferOptions = {},
): Promise<Response> {
  const deadline = Date.now() + TRANSFER_TIMEOUT;
  const parts = sealed.chunks.length;
  if (!parts || parts > MAX_SEALED_PARTS) return tooLarge();
  const started = await request("/api/sync/transfer", deadline, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts,
      hashes: sealed.chunks.map((chunk) => chunk.id),
      sealed: true,
    }),
  });
  if (!started.ok) return started;
  const { id, missing, concurrency: allowance } = await started.json();
  if (
    typeof id !== "string" ||
    !UPLOAD_ID_PATTERN.test(id) ||
    !Array.isArray(missing) ||
    !validMissing(missing, parts)
  ) {
    throw new Error(negativeMessage("sync transfer is unavailable"));
  }
  const failure = await transferParts(missing, concurrency(allowance), async (part) => {
    remaining(deadline);
    const chunk = sealed.chunks[part]!;
    const plaintext = new Uint8Array(
      await body.slice(chunk.offset, chunk.offset + chunk.length).arrayBuffer(),
    );
    const payload = await sealChunk(keys, chunk.id, plaintext);
    if (payload.length > CHUNK_SIZE) {
      throw new Error(negativeMessage("sync payload is too large"));
    }
    return request(`/api/sync/transfer/${id}/${part}`, deadline, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([payload]),
    });
  });
  if (failure) return failure;
  return commitRequest(id, deadline, options, sealed.seal);
}

interface LocalChunks {
  body: Blob;
  chunks: SnapshotChunk[];
}

export interface DownloadOptions {
  keys?: SyncKeys | null;
  local?: LocalChunks | Promise<LocalChunks | null> | null;
  progress?: (done: number, total: number) => void;
}

function partProgress(
  total: number,
  progress: DownloadOptions["progress"],
): () => void {
  let done = 0;
  progress?.(done, total);
  return () => progress?.(++done, total);
}

function joinedSnapshot(
  chunks: Blob[],
  updatedAt: string,
  sealed: boolean,
): Response {
  return new Response(
    new Blob([
      '{"success":true,"sealed":',
      String(sealed),
      ',"data":',
      ...chunks,
      ',"updated_at":',
      JSON.stringify(updatedAt),
      "}",
    ]),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function downloadSealed(
  manifest: Record<string, unknown>,
  deadline: number,
  options: DownloadOptions,
): Promise<Response> {
  const keys = options.keys;
  if (!keys) {
    return sealedFailure("sync_data_sealed", "synced data is end-to-end encrypted");
  }
  const digests = manifest.digests;
  if (
    !Array.isArray(digests) ||
    digests.length !== manifest.parts ||
    !digests.every(
      (digest): digest is string =>
        typeof digest === "string" && DIGEST_PATTERN.test(digest),
    ) ||
    typeof manifest.seal !== "string" ||
    !(await verifyManifestSeal(keys, digests, manifest.seal))
  ) {
    return sealedFailure("sync_key_mismatch", "synced data needs a different password");
  }
  const reusable = await options.local;
  const local = new Map<string, Blob>();
  for (const chunk of reusable?.chunks ?? []) {
    local.set(
      chunk.id,
      reusable!.body.slice(chunk.offset, chunk.offset + chunk.length),
    );
  }
  const opened = new Map<string, Promise<Blob>>();
  const chunks: Blob[] = [];
  const indexes = Array.from({ length: digests.length }, (_, part) => part);
  const advance = partProgress(digests.length, options.progress);
  const failure = await transferParts(
    indexes,
    concurrency(manifest.concurrency),
    async (part) => {
      const digest = digests[part]!;
      const reused = local.get(digest);
      if (reused) {
        chunks[part] = reused;
        advance();
        return new Response(null, { status: 204 });
      }
      let pending = opened.get(digest);
      if (!pending) {
        pending = (async () => {
          const chunk = await request(`/api/sync/transfer/${manifest.id}/${part}`, deadline);
          if (!chunk.ok) throw chunk;
          const bytes = new Uint8Array(await chunk.arrayBuffer());
          if (!bytes.length || bytes.length > CHUNK_SIZE) {
            throw new Error(negativeMessage("synced data is unavailable"));
          }
          return new Blob([await openChunk(keys, digest, bytes, CHUNK_SIZE)]);
        })();
        opened.set(digest, pending);
      }
      try {
        chunks[part] = await pending;
      } catch (error) {
        if (error instanceof Response) return error;
        throw error;
      }
      advance();
      return new Response(null, { status: 204 });
    },
  );
  if (failure) return failure;
  return joinedSnapshot(chunks, manifest.updated_at as string, true);
}

export async function downloadSnapshot(
  options: DownloadOptions = {},
): Promise<Response> {
  const deadline = Date.now() + TRANSFER_TIMEOUT;
  options = {
    ...options,
    local: Promise.resolve(options.local ?? null).catch(() => null),
  };
  const response = await request("/api/sync/transfer", deadline);
  if (!response.ok) return response;
  const manifest = await response.json();
  if (manifest.legacy === true) return request("/api/sync/download", deadline);
  if (
    typeof manifest.id !== "string" ||
    !UPLOAD_ID_PATTERN.test(manifest.id) ||
    !Number.isSafeInteger(manifest.parts) ||
    manifest.parts <= 0 ||
    manifest.parts > (manifest.sealed === true ? MAX_SEALED_PARTS : MAX_PARTS) ||
    typeof manifest.updated_at !== "string"
  ) {
    throw new Error(negativeMessage("synced data is unavailable"));
  }
  if (manifest.sealed === true) return downloadSealed(manifest, deadline, options);
  const chunks: Blob[] = [];
  const indexes = Array.from({ length: manifest.parts }, (_, part) => part);
  const advance = partProgress(manifest.parts, options.progress);
  const failure = await transferParts(indexes, concurrency(manifest.concurrency), async (part) => {
    const chunk = await request(`/api/sync/transfer/${manifest.id}/${part}`, deadline);
    if (!chunk.ok) return chunk;
    const bytes = await chunk.blob();
    if (!bytes.size || bytes.size > CHUNK_SIZE) {
      throw new Error(negativeMessage("synced data is unavailable"));
    }
    chunks[part] = bytes;
    advance();
    return chunk;
  });
  if (failure) return failure;
  return joinedSnapshot(chunks, manifest.updated_at, false);
}
