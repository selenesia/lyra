import {
  type KeyPath,
  FOLIO_STORE,
  hasOwn,
  type SyncSnapshot,
  SYNC_SCHEMA_VERSION,
  type SyncDatabase,
  type SyncStore,
  type SyncRecord,
  FOLIO_COOKIE_KEY,
  type SyncCookie,
} from "./snapshotSchema.ts";
import {
  FOLIO_DB,
  isSensitiveSyncText,
  isSiteStorageName,
  isSensitiveSyncName,
  allowsSensitiveDatabase,
} from "./syncPolicy.ts";
import { isRecord, encodeBrowserValue } from "./snapshotValue.ts";
import { credentialCookieName, legacyCookies } from "./snapshotCookies.ts";
import { isSyncSnapshot } from "./snapshotSchema.ts";
import { sanitizeFolioCookieState } from "./folioCookies.ts";

function legacyStoreSchema(
  databaseName: string,
  storeName: string,
  usesOutOfLineKeys: boolean,
  records: unknown[],
): { keyPath: KeyPath; autoIncrement: boolean } {
  if (usesOutOfLineKeys) return { keyPath: null, autoIncrement: false };
  if (databaseName === "rivet_extensions" && storeName === "extensions") {
    return { keyPath: "id", autoIncrement: false };
  }
  if (databaseName === FOLIO_DB && storeName === FOLIO_STORE) {
    return { keyPath: null, autoIncrement: false };
  }
  if (
    records.length > 0 &&
    records.every((record) => isRecord(record) && hasOwn(record, "id"))
  ) {
    return { keyPath: "id", autoIncrement: false };
  }
  return { keyPath: null, autoIncrement: true };
}

export async function normalizeLegacySnapshot(
  value: unknown,
): Promise<SyncSnapshot | null> {
  if (
    !isRecord(value) ||
    !isRecord(value.localStorage) ||
    !isRecord(value.indexedDB)
  ) {
    return null;
  }
  if (
    value.schemaVersion === 1 &&
    isRecord(value.sessionStorage) &&
    (typeof value.cookies === "string" || isRecord(value.cookies))
  ) {
    const cookieHeader =
      typeof value.cookies === "string"
        ? value.cookies
        : Object.entries(value.cookies)
            .filter(
              ([name, entry]) =>
                !credentialCookieName(name) &&
                typeof entry === "string" &&
                !isSensitiveSyncText(entry),
            )
            .map(([name, entry]) => `${name}=${entry}`)
            .join("; ");
    const migrated = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      localStorage: value.localStorage,
      sessionStorage: value.sessionStorage,
      cookies: legacyCookies(cookieHeader),
      indexedDB: value.indexedDB,
    };
    return isSyncSnapshot(migrated) ? migrated : null;
  }
  const localStorage: Record<string, string> = {};
  const sessionStorage: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.localStorage)) {
    if (
      typeof entry === "string" &&
      (isSiteStorageName(key) || !isSensitiveSyncName(key))
    ) {
      localStorage[key] = entry;
    }
  }
  if (isRecord(value.sessionStorage)) {
    for (const [key, entry] of Object.entries(value.sessionStorage)) {
      if (
        typeof entry === "string" &&
        (isSiteStorageName(key) || !isSensitiveSyncName(key))
      ) {
        sessionStorage[key] = entry;
      }
    }
  }

  const indexedDB: Record<string, SyncDatabase> = {};
  for (const [databaseName, legacyDatabase] of Object.entries(
    value.indexedDB,
  )) {
    const allowSensitive = allowsSensitiveDatabase(databaseName);
    if (
      (!allowSensitive && isSensitiveSyncName(databaseName)) ||
      !isRecord(legacyDatabase)
    ) {
      continue;
    }
    const stores: Record<string, SyncStore> = {};
    for (const [storeName, legacyStore] of Object.entries(legacyDatabase)) {
      if (
        (!allowSensitive && isSensitiveSyncName(storeName)) ||
        !isRecord(legacyStore)
      ) {
        continue;
      }
      const records = Array.isArray(legacyStore.data) ? legacyStore.data : [];
      const usesOutOfLineKeys = legacyStore.usesOutOfLineKeys === true;
      const schema = legacyStoreSchema(
        databaseName,
        storeName,
        usesOutOfLineKeys,
        records,
      );
      const normalizedRecords: SyncRecord[] = [];
      for (let index = 0; index < records.length; index++) {
        const legacyRecord = records[index];
        let recordKey: unknown;
        let recordValue: unknown;
        if (
          usesOutOfLineKeys &&
          isRecord(legacyRecord) &&
          hasOwn(legacyRecord, "key") &&
          hasOwn(legacyRecord, "value")
        ) {
          recordKey = legacyRecord.key;
          recordValue = legacyRecord.value;
        } else {
          recordValue = legacyRecord;
          recordKey =
            schema.keyPath === "id" && isRecord(legacyRecord)
              ? legacyRecord.id
              : index + 1;
        }
        if (!allowSensitive && isSensitiveSyncName(String(recordKey))) continue;
        if (
          databaseName === FOLIO_DB &&
          storeName === FOLIO_STORE &&
          recordKey === FOLIO_COOKIE_KEY
        ) {
          recordValue = sanitizeFolioCookieState(recordValue, allowSensitive);
        }
        normalizedRecords.push({
          key: await encodeBrowserValue(recordKey, allowSensitive),
          value: await encodeBrowserValue(recordValue, allowSensitive),
        });
      }
      stores[storeName] = {
        ...schema,
        indexes: {},
        records: normalizedRecords,
      };
    }
    indexedDB[databaseName] = { stores };
  }
  let cookies: SyncCookie[] = [];
  if (typeof value.cookies === "string") {
    cookies = legacyCookies(value.cookies);
  } else if (isRecord(value.cookies)) {
    const cookieHeader: string[] = [];
    for (const [key, entry] of Object.entries(value.cookies)) {
      if (
        !credentialCookieName(key) &&
        typeof entry === "string" &&
        !isSensitiveSyncText(entry)
      ) {
        cookieHeader.push(`${key}=${entry}`);
      }
    }
    cookies = legacyCookies(cookieHeader.join("; "));
  }
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    localStorage,
    sessionStorage,
    cookies,
    indexedDB,
  };
}
