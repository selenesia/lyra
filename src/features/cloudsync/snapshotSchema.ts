import {
  isRecord,
  validEncodedValue,
  type EncodedValue,
} from "./snapshotValue.ts";
import {
  isSiteStorageName,
  isSensitiveSyncName,
  isSensitiveSyncText,
  allowsSensitiveDatabase,
} from "./syncPolicy.ts";
import { validCookie, cookieIdentity } from "./snapshotCookies.ts";

export const SYNC_SCHEMA_VERSION = 3 as const;
const LEGACY_SYNC_SCHEMA_VERSION = 2 as const;
export const FOLIO_STORE = "state";
export const FOLIO_COOKIE_KEY = "cookies";
export const FOLIO_CHANNEL = "__folio_controller_channel";

export type KeyPath = string | string[] | null;

export interface SyncRecord {
  key: EncodedValue;
  value: EncodedValue;
}

export interface SyncIndex {
  keyPath: KeyPath;
  unique: boolean;
  multiEntry: boolean;
}

export interface SyncStore {
  keyPath: KeyPath;
  autoIncrement: boolean;
  indexes: Record<string, SyncIndex>;
  records: SyncRecord[];
}

export interface SyncDatabase {
  stores: Record<string, SyncStore>;
}

export type SyncSameSite = "strict" | "lax" | "none";

export interface SyncCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string;
  expires: number | null;
  sameSite: SyncSameSite;
  secure: boolean;
  partitioned: boolean;
}

export interface SyncSnapshot {
  schemaVersion: typeof LEGACY_SYNC_SCHEMA_VERSION | typeof SYNC_SCHEMA_VERSION;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: SyncCookie[];
  indexedDB: Record<string, SyncDatabase>;
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function keyPath(value: string | string[] | null): KeyPath {
  return Array.isArray(value) ? [...value] : value;
}

function validKeyPath(value: unknown): value is KeyPath {
  return (
    value === null ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

export function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  if (
    !isRecord(value) ||
    ![LEGACY_SYNC_SCHEMA_VERSION, SYNC_SCHEMA_VERSION].includes(
      value.schemaVersion as 2 | 3,
    ) ||
    Object.keys(value).length !== 5
  ) {
    return false;
  }
  const includeSensitive = value.schemaVersion === SYNC_SCHEMA_VERSION;
  for (const field of ["localStorage", "sessionStorage"] as const) {
    const entries = value[field];
    if (
      !isRecord(entries) ||
      Object.entries(entries).some(
        ([key, entry]) =>
          typeof entry !== "string" ||
          ((!includeSensitive || !isSiteStorageName(key)) &&
            (isSensitiveSyncName(key) || isSensitiveSyncText(entry))),
      )
    ) {
      return false;
    }
  }
  if (
    !Array.isArray(value.cookies) ||
    value.cookies.some((entry) => {
      if (!isRecord(entry)) return true;
      const cookie = entry as unknown as SyncCookie;
      return (
        Object.keys(entry).length !== 8 ||
        typeof cookie.name !== "string" ||
        typeof cookie.value !== "string" ||
        (cookie.domain !== null && typeof cookie.domain !== "string") ||
        typeof cookie.path !== "string" ||
        (cookie.expires !== null && typeof cookie.expires !== "number") ||
        typeof cookie.sameSite !== "string" ||
        typeof cookie.secure !== "boolean" ||
        typeof cookie.partitioned !== "boolean" ||
        !validCookie(cookie)
      );
    })
  ) {
    return false;
  }
  const cookieIds = new Set<string>();
  for (const cookie of value.cookies as unknown as SyncCookie[]) {
    const identity = cookieIdentity(cookie);
    if (cookieIds.has(identity)) return false;
    cookieIds.add(identity);
  }
  if (!isRecord(value.indexedDB)) return false;
  return Object.entries(value.indexedDB).every(([databaseName, database]) => {
    const allowSensitive =
      includeSensitive && allowsSensitiveDatabase(databaseName);
    if (
      (!allowSensitive && isSensitiveSyncName(databaseName)) ||
      !isRecord(database)
    ) {
      return false;
    }
    if (!isRecord(database.stores)) return false;
    return Object.entries(database.stores).every(([storeName, store]) => {
      if (
        (!allowSensitive && isSensitiveSyncName(storeName)) ||
        !isRecord(store)
      ) {
        return false;
      }
      if (
        !validKeyPath(store.keyPath) ||
        typeof store.autoIncrement !== "boolean" ||
        !isRecord(store.indexes) ||
        !Array.isArray(store.records)
      ) {
        return false;
      }
      const indexesValid = Object.values(store.indexes).every(
        (index) =>
          isRecord(index) &&
          validKeyPath(index.keyPath) &&
          typeof index.unique === "boolean" &&
          typeof index.multiEntry === "boolean",
      );
      return (
        indexesValid &&
        store.records.every(
          (record) =>
            isRecord(record) &&
            validEncodedValue(record.key, new Set<number>(), allowSensitive) &&
            validEncodedValue(record.value, new Set<number>(), allowSensitive),
        )
      );
    });
  });
}
