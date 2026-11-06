import { syncError } from "./snapshotValue.ts";
import {
  deleteLocalState,
  readLocalState,
  writeLocalState,
} from "./syncLocalState.ts";

export type SyncBytes = Uint8Array<ArrayBuffer>;

export interface SyncKeys {
  encryption: CryptoKey;
  identity: CryptoKey;
}

const KDF_ITERATIONS = 600_000;
const CHUNK_FORMAT = 1;
const COMPRESSED = 1;
const NONCE_BYTES = 12;
const HEADER_BYTES = 2 + NONCE_BYTES;
const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw syncError("encryption is unavailable");
  return value;
}

function bytesFromBase64(value: string): SyncBytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canEncryptSync(): boolean {
  return Boolean(globalThis.crypto?.subtle);
}

const WRAP_VERSION = 1;
const MASTER_BYTES = 32;
const WRAPPED_BYTES = 1 + NONCE_BYTES + MASTER_BYTES + 16;

function bytesFromBase64Url(value: string): SyncBytes {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw syncError("invalid base64url");
  return bytesFromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  return base64FromBytes(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function wrapKey(
  exportKey: string,
  username: string,
  usage: KeyUsage,
): Promise<{ key: CryptoKey; aad: SyncBytes }> {
  const crypto = subtle();
  const raw = bytesFromBase64Url(exportKey);
  try {
    const root = await crypto.importKey("raw", raw, "HKDF", false, [
      "deriveKey",
    ]);
    const key = await crypto.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: encoder.encode("lyra-sync-v5 wrap"),
      },
      root,
      { name: "AES-GCM", length: 256 },
      false,
      [usage],
    );
    return { key, aad: encoder.encode(`lyra-sync-v5 wrap:${username}`) };
  } finally {
    raw.fill(0);
  }
}

export function newMaster(): SyncBytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(MASTER_BYTES));
}

export async function wrapMaster(
  exportKey: string,
  master: SyncBytes,
  username: string,
): Promise<string> {
  const { key, aad } = await wrapKey(exportKey, username, "encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      key,
      master,
    ),
  );
  const wrapped = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  wrapped[0] = WRAP_VERSION;
  wrapped.set(nonce, 1);
  wrapped.set(ciphertext, 1 + NONCE_BYTES);
  return base64UrlFromBytes(wrapped);
}

export async function unwrapMaster(
  exportKey: string,
  wrapped: string,
  username: string,
): Promise<SyncBytes> {
  try {
    const bytes = bytesFromBase64Url(wrapped);
    if (bytes.length !== WRAPPED_BYTES || bytes[0] !== WRAP_VERSION) {
      throw syncError("invalid wrapped key");
    }
    const { key, aad } = await wrapKey(exportKey, username, "decrypt");
    return new Uint8Array(
      await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(1, 1 + NONCE_BYTES),
          additionalData: aad,
        },
        key,
        bytes.subarray(1 + NONCE_BYTES),
      ),
    );
  } catch {
    throw syncError("synced data could not be decrypted");
  }
}

export async function legacyMaster(
  password: string,
  salt: string,
): Promise<SyncBytes> {
  const crypto = subtle();
  const passwordKey = await crypto.importKey(
    "raw",
    encoder.encode(password.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const saltBytes = new Uint8Array([
    ...encoder.encode("lyra-sync-v4:"),
    ...bytesFromBase64(salt),
  ]);
  return new Uint8Array(
    await crypto.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: saltBytes,
        iterations: KDF_ITERATIONS,
      },
      passwordKey,
      256,
    ),
  );
}

export async function keysFromMaster(master: SyncBytes): Promise<SyncKeys> {
  const crypto = subtle();
  const root = await crypto.importKey("raw", master, "HKDF", false, [
    "deriveKey",
  ]);
  const derive = (info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    crypto.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: encoder.encode(info),
      },
      root,
      algorithm,
      false,
      usages,
    );
  return {
    encryption: await derive(
      "lyra-sync-v4 encryption",
      { name: "AES-GCM", length: 256 },
      ["encrypt", "decrypt"],
    ),
    identity: await derive(
      "lyra-sync-v4 identity",
      { name: "HMAC", hash: "SHA-256", length: 256 },
      ["sign", "verify"],
    ),
  };
}

function keyName(userId: unknown): string | null {
  return typeof userId === "number" || typeof userId === "string"
    ? String(userId)
    : null;
}

export async function loadSyncKeys(userId: unknown): Promise<SyncKeys | null> {
  const name = keyName(userId);
  if (!name) return null;
  const stored = await readLocalState<SyncKeys>("keys", name);
  return stored &&
    typeof stored === "object" &&
    stored.encryption &&
    stored.identity
    ? stored
    : null;
}

export async function saveSyncKeys(
  userId: unknown,
  keys: SyncKeys,
): Promise<void> {
  const name = keyName(userId);
  if (name) await writeLocalState("keys", name, keys);
}

export async function forgetSyncKeys(userId: unknown): Promise<void> {
  const name = keyName(userId);
  if (name) await deleteLocalState("keys", name);
}

export async function chunkId(
  keys: SyncKeys,
  bytes: SyncBytes,
): Promise<string> {
  return hex(await subtle().sign("HMAC", keys.identity, bytes));
}

async function transform(
  bytes: SyncBytes,
  stream: CompressionStream | DecompressionStream,
): Promise<SyncBytes> {
  return new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );
}

async function compress(bytes: SyncBytes): Promise<SyncBytes | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const compressed = await transform(
      bytes,
      new CompressionStream("deflate-raw"),
    );
    return compressed.length < bytes.length ? compressed : null;
  } catch {
    return null;
  }
}

export async function sealChunk(
  keys: SyncKeys,
  id: string,
  bytes: SyncBytes,
): Promise<SyncBytes> {
  const compressed = await compress(bytes);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encoder.encode(`lyra-sync-v4:${id}`),
      },
      keys.encryption,
      compressed ?? bytes,
    ),
  );
  const sealed = new Uint8Array(HEADER_BYTES + ciphertext.length);
  sealed[0] = CHUNK_FORMAT;
  sealed[1] = compressed ? COMPRESSED : 0;
  sealed.set(nonce, 2);
  sealed.set(ciphertext, HEADER_BYTES);
  return sealed;
}

export async function openChunk(
  keys: SyncKeys,
  id: string,
  sealed: SyncBytes,
  maxBytes: number,
): Promise<SyncBytes> {
  if (sealed.length <= HEADER_BYTES || sealed[0] !== CHUNK_FORMAT) {
    throw syncError("synced data is unavailable");
  }
  let opened: SyncBytes;
  try {
    opened = new Uint8Array(
      await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: sealed.subarray(2, HEADER_BYTES),
          additionalData: encoder.encode(`lyra-sync-v4:${id}`),
        },
        keys.encryption,
        sealed.subarray(HEADER_BYTES),
      ),
    );
  } catch {
    throw syncError("synced data could not be decrypted");
  }
  const bytes =
    sealed[1] === COMPRESSED
      ? await transform(opened, new DecompressionStream("deflate-raw"))
      : opened;
  if (!bytes.length || bytes.length > maxBytes || (await chunkId(keys, bytes)) !== id) {
    throw syncError("synced data is unavailable");
  }
  return bytes;
}

function manifestBytes(ids: readonly string[]): SyncBytes {
  return encoder.encode(`lyra-sync-v4 manifest\n${ids.join("\n")}`);
}

export async function manifestSeal(
  keys: SyncKeys,
  ids: readonly string[],
): Promise<string> {
  return base64FromBytes(
    new Uint8Array(await subtle().sign("HMAC", keys.identity, manifestBytes(ids))),
  );
}

export async function verifyManifestSeal(
  keys: SyncKeys,
  ids: readonly string[],
  seal: string,
): Promise<boolean> {
  try {
    return await subtle().verify(
      "HMAC",
      keys.identity,
      bytesFromBase64(seal),
      manifestBytes(ids),
    );
  } catch {
    return false;
  }
}
