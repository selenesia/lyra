export const FOLIO_DB = "__folio_controller";

export const IDB_REGISTRY_KEY = "lyra-sync-idb-names";
const LOCAL_ONLY_RIVET_STORES = new Set(["extensions", "extension_files"]);
const LOCAL_ONLY_EXTENSION_CACHE = /^[^/]+\/local\/cache\/(?:compiled|selfie)\//;
export const SYNC_LOCAL_DATABASE = "lyra-sync-local";
export const LOCAL_ONLY_DATABASES = new Set([
  "uBlock0CacheStorage",
  "UnityCache",
  SYNC_LOCAL_DATABASE,
]);
const GAME_FILE_FIELDS = new Set(["timestamp", "mode", "contents"]);
const MAX_GAME_FILE_BYTES = 8 * 1024 * 1024;
const LOCAL_STORAGE_PREFIXES = [
  "lyra-game-cache-",
  "lyra-anime-feed-entries-",
  "lyra-anime-search-entries-",
  "lyra-anime-episode-count-",
];
const LOCAL_STORAGE_KEYS = new Set([
  "lyraVersion",
  "lyraVersionStamp",
  "lyraUpdateTarget",
  "lyraUpdateAttempt",
  "lyraPresenceId",
  "lyra-title-peak-index",
  "lyra-search-placeholder-index",
  "bare-mux-path",
]);

export function isLocalOnlySyncStorageKey(name: string): boolean {
  return (
    LOCAL_STORAGE_KEYS.has(name) ||
    LOCAL_STORAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

const LOCAL_ONLY_KEYS = new Set([
  "auth_user",
  "auth_token",
  "lyra-sync-meta",
  IDB_REGISTRY_KEY,
  "__lyra_folio_session",
]);

const SENSITIVE_PARTS = new Set([
  "password",
  "passwd",
  "secret",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "csrf",
  "oauth",
  "token",
  "jwt",
  "session",
  "sessionid",
  "xsrf",
]);

function normalizedParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveSyncName(name: string): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return false;
  const leaf = normalized.slice(normalized.lastIndexOf("@") + 1);
  const originalLeaf = trimmed.slice(trimmed.lastIndexOf("@") + 1);
  if (LOCAL_ONLY_KEYS.has(normalized) || LOCAL_ONLY_KEYS.has(leaf)) return true;
  if (
    /(?:access|refresh|identity|id|auth|session|api|private)[_-]?token/.test(
      leaf,
    ) ||
    /(?:csrf|xsrf|oauth)[_-]?token/.test(leaf) ||
    /(?:api|private)[_-]?key/.test(leaf)
  ) {
    return true;
  }
  return normalizedParts(originalLeaf).some((part) =>
    SENSITIVE_PARTS.has(part),
  );
}

export function isSiteStorageName(name: string): boolean {
  const separator = name.lastIndexOf("@");
  return separator > 0 && separator < name.length - 1;
}

export function isSiteDatabaseName(name: string): boolean {
  const separator = name.lastIndexOf("@");
  if (separator < 1 || separator === name.length - 1) return false;
  const origin = name.slice(0, separator).toLowerCase();
  return origin.startsWith("https://") || origin.startsWith("http://");
}

export function allowsSensitiveDatabase(name: string): boolean {
  return (
    name === FOLIO_DB || name === "rivet_extensions" || isSiteDatabaseName(name)
  );
}

export function canSyncIndexedDBStore(
  databaseName: string,
  storeName: string,
): boolean {
  return (
    !LOCAL_ONLY_DATABASES.has(databaseName) &&
    (databaseName !== "rivet_extensions" ||
      !LOCAL_ONLY_RIVET_STORES.has(storeName))
  );
}

export function isLocalOnlyRecord(
  databaseName: string,
  storeName: string,
  key: unknown,
): boolean {
  return (
    databaseName === "rivet_extensions" &&
    storeName === "extension_storage" &&
    typeof key === "string" &&
    LOCAL_ONLY_EXTENSION_CACHE.test(key)
  );
}

export function isGameFileRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (
    !keys.every((key) => GAME_FILE_FIELDS.has(key)) ||
    typeof entry.mode !== "number" ||
    !(entry.timestamp instanceof Date || typeof entry.timestamp === "number")
  ) {
    return false;
  }
  if (!("contents" in entry)) return true;
  const contents = entry.contents;
  return (
    (ArrayBuffer.isView(contents) || contents instanceof ArrayBuffer) &&
    contents.byteLength <= MAX_GAME_FILE_BYTES
  );
}

export function containsLocalOnlySiteData(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  ) {
    return true;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) {
      if (containsLocalOnlySiteData(entry, seen)) return true;
    }
    return false;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (
        containsLocalOnlySiteData(key, seen) ||
        containsLocalOnlySiteData(entry, seen)
      ) {
        return true;
      }
    }
    return false;
  }
  return Object.values(value).some((entry) =>
    containsLocalOnlySiteData(entry, seen),
  );
}

function looksLikeJwt(value: string): boolean {
  const parts = value.trim().split(".");
  return (
    parts.length === 3 &&
    parts[0]!.startsWith("eyJ") &&
    parts[1]!.startsWith("eyJ") &&
    parts.every((part) => part.length >= 8 && /^[a-zA-Z0-9_-]+$/.test(part))
  );
}

function looksLikeProviderCredential(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^(?:bearer|basic)\s+\S{8,}$/i.test(trimmed) ||
    /-----begin [^-\r\n]*private key-----/i.test(trimmed) ||
    /^\$(?:2[aby]|argon2(?:id|i|d))\$/.test(trimmed) ||
    /^(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|xox[baprs]-\S{10,}|sk_(?:live|test)_[a-zA-Z0-9]{12,})$/.test(
      trimmed,
    ) ||
    /^AKIA[A-Z0-9]{16}$/.test(trimmed)
  );
}

function containsCredentialText(value: string): boolean {
  if (looksLikeJwt(value) || looksLikeProviderCredential(value)) return true;
  return (
    /(?:^|[^a-zA-Z0-9_-])eyJ[a-zA-Z0-9_-]{5,}\.eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{8,}(?:$|[^a-zA-Z0-9_-])/.test(
      value,
    ) ||
    /["'](?:access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|api[_-]?key|private[_-]?key|password|passwd|secret|authorization|credential|jwt)["']\s*[:=]/i.test(
      value,
    ) ||
    /(?:^|[\s"'=:\[])(?:bearer|basic)\s+[a-zA-Z0-9+/_=-]{8,}/i.test(value) ||
    /(?:^|[^a-zA-Z0-9_])(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|xox[baprs]-\S{10,}|sk_(?:live|test)_[a-zA-Z0-9]{12,}|AKIA[A-Z0-9]{16})(?:$|[^a-zA-Z0-9_])/.test(
      value,
    ) ||
    /-----begin [^-\r\n]*private key-----/i.test(value) ||
    /\$(?:2[aby]|argon2(?:id|i|d))\$/.test(value)
  );
}

function containsSensitiveJson(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return isSensitiveSyncText(value, false);
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveJson(entry, seen));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveSyncName(key) || containsSensitiveJson(entry, seen))
      return true;
  }
  return false;
}

export function isSensitiveSyncText(
  value: string,
  inspectJson = true,
): boolean {
  if (containsCredentialText(value)) return true;
  if (!inspectJson || value.length > 1024 * 1024) return false;
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return false;
  }
  try {
    return containsSensitiveJson(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

export function canSyncStorageValue(name: string, value: string): boolean {
  return (
    !isLocalOnlySyncStorageKey(name) &&
    (isSiteStorageName(name) ||
      (!isSensitiveSyncName(name) && !isSensitiveSyncText(value)))
  );
}

export function bytesContainSensitiveText(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder();
  const chunkSize = 64 * 1024;
  const overlap = 512;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const start = Math.max(0, offset - overlap);
    const text = decoder.decode(bytes.subarray(start, offset + chunkSize));
    if (containsCredentialText(text)) return true;
  }
  return false;
}

export async function containsSensitiveTextValue(
  value: unknown,
  inspectNames = false,
  seen = new WeakSet<object>(),
): Promise<boolean> {
  if (typeof value === "string") return isSensitiveSyncText(value);
  if (typeof value !== "object" || value === null) return false;
  if (isCredentialObject(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof ArrayBuffer) {
    return bytesContainSensitiveText(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return bytesContainSensitiveText(new Uint8Array(value.buffer));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return bytesContainSensitiveText(new Uint8Array(await value.arrayBuffer()));
  }
  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) {
      if (await containsSensitiveTextValue(entry, inspectNames, seen))
        return true;
    }
    return false;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (
        (inspectNames && typeof key === "string" && isSensitiveSyncName(key)) ||
        (await containsSensitiveTextValue(key, inspectNames, seen)) ||
        (await containsSensitiveTextValue(entry, inspectNames, seen))
      ) {
        return true;
      }
    }
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      (inspectNames && isSensitiveSyncName(key)) ||
      (await containsSensitiveTextValue(entry, inspectNames, seen))
    ) {
      return true;
    }
  }
  return false;
}

export function isCredentialObject(value: object): boolean {
  return [
    "[object CryptoKey]",
    "[object Credential]",
    "[object PasswordCredential]",
    "[object FederatedCredential]",
    "[object PublicKeyCredential]",
  ].includes(Object.prototype.toString.call(value));
}
