import {
  syncError,
  encodeBrowserValue,
  validEncodedValue,
} from "./snapshotValue.ts";
import {
  FOLIO_DB,
  IDB_REGISTRY_KEY,
  allowsSensitiveDatabase,
  isSensitiveSyncName,
  LOCAL_ONLY_DATABASES,
  canSyncIndexedDBStore,
  isLocalOnlyRecord,
  containsSensitiveTextValue,
  isSiteDatabaseName,
  isGameFileRecord,
  containsLocalOnlySiteData,
} from "./syncPolicy.ts";
import {
  type SyncStore,
  type SyncIndex,
  keyPath,
  type SyncRecord,
  FOLIO_STORE,
  FOLIO_COOKIE_KEY,
  type SyncDatabase,
} from "./snapshotSchema.ts";
import { sanitizeFolioCookieState } from "./folioCookies.ts";

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(syncError("indexeddb transaction aborted"));
    transaction.onerror = () =>
      reject(syncError("indexeddb transaction failed"));
  });
}

function registeredDatabaseNames(): Set<string> {
  const names = new Set([FOLIO_DB, "rivet_extensions"]);
  try {
    const stored = globalThis.localStorage?.getItem(IDB_REGISTRY_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      for (const name of parsed) {
        if (
          typeof name === "string" &&
          name &&
          (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name))
        ) {
          names.add(name);
        }
      }
    }
  } catch {}
  return names;
}

function saveDatabaseNames(names: Iterable<string>): void {
  try {
    const safe = [...new Set(names)]
      .filter(
        (name) =>
          name && (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name)),
      )
      .sort();
    globalThis.localStorage?.setItem(IDB_REGISTRY_KEY, JSON.stringify(safe));
  } catch {}
}

export function rememberIndexedDBName(name: string): void {
  if (
    !name ||
    LOCAL_ONLY_DATABASES.has(name) ||
    (!allowsSensitiveDatabase(name) && isSensitiveSyncName(name))
  ) {
    return;
  }
  const names = registeredDatabaseNames();
  names.add(name);
  saveDatabaseNames(names);
}

export function forgetIndexedDBName(name: string): void {
  const names = registeredDatabaseNames();
  names.delete(name);
  saveDatabaseNames(names);
}

export async function databaseNames(factory: IDBFactory): Promise<string[]> {
  if (typeof factory.databases === "function") {
    const names = (await factory.databases())
      .map((database) => database.name)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          name.length > 0 &&
          !LOCAL_ONLY_DATABASES.has(name) &&
          (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name)),
      )
      .sort();
    saveDatabaseNames(names);
    return names;
  }

  const names: string[] = [];
  for (const name of [...registeredDatabaseNames()].sort()) {
    if (LOCAL_ONLY_DATABASES.has(name)) continue;
    try {
      const database = await openExistingDatabase(factory, name);
      database.close();
      names.push(name);
    } catch {}
  }
  return names;
}

export function openExistingDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(syncError("indexeddb database open failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb database open blocked"));
  });
}

export async function readRawRecords(
  store: IDBObjectStore,
): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const records: Array<{ key: IDBValidKey; value: unknown }> = [];
    const request = store.openCursor();
    request.onerror = () => reject(syncError("indexeddb cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }
      records.push({ key: cursor.primaryKey, value: cursor.value });
      cursor.continue();
    };
  });
}

async function exportStore(
  database: IDBDatabase,
  storeName: string,
  allowSensitive: boolean,
): Promise<SyncStore> {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const indexes: Record<string, SyncIndex> = {};
  for (const indexName of Array.from(store.indexNames).sort()) {
    if (!allowSensitive && isSensitiveSyncName(indexName)) continue;
    const index = store.index(indexName);
    indexes[indexName] = {
      keyPath: keyPath(index.keyPath),
      unique: index.unique,
      multiEntry: index.multiEntry,
    };
  }
  if (!canSyncIndexedDBStore(database.name, storeName)) {
    await done;
    return {
      keyPath: keyPath(store.keyPath),
      autoIncrement: store.autoIncrement,
      indexes,
      records: [],
    };
  }
  const rawRecords = await readRawRecords(store);
  await done;
  const records: SyncRecord[] = [];
  for (const record of rawRecords) {
    if (isLocalOnlyRecord(database.name, storeName, record.key)) continue;
    if (!allowSensitive && isSensitiveSyncName(String(record.key))) continue;
    const value =
      database.name === FOLIO_DB &&
      storeName === FOLIO_STORE &&
      record.key === FOLIO_COOKIE_KEY
        ? sanitizeFolioCookieState(record.value, allowSensitive)
        : record.value;
    if (!allowSensitive && (await containsSensitiveTextValue(value))) continue;
    const encoded = await encodeRecord(
      database.name,
      record.key,
      value,
      allowSensitive,
    );
    if (encoded) records.push(encoded);
  }
  return {
    keyPath: keyPath(store.keyPath),
    autoIncrement: store.autoIncrement,
    indexes,
    records,
  };
}

export async function encodeRecord(
  databaseName: string,
  key: IDBValidKey,
  value: unknown,
  allowSensitive: boolean,
): Promise<SyncRecord | null> {
  if (
    isSiteDatabaseName(databaseName) &&
    !isGameFileRecord(value) &&
    (containsLocalOnlySiteData(key) || containsLocalOnlySiteData(value))
  ) {
    return null;
  }
  try {
    const record = {
      key: await encodeBrowserValue(key, allowSensitive),
      value: await encodeBrowserValue(value, allowSensitive),
    };
    if (
      !validEncodedValue(record.key, new Set<number>(), allowSensitive) ||
      !validEncodedValue(record.value, new Set<number>(), allowSensitive)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export async function exportDatabase(
  factory: IDBFactory,
  name: string,
): Promise<SyncDatabase> {
  const database = await openExistingDatabase(factory, name);
  try {
    const allowSensitive = allowsSensitiveDatabase(name);
    const stores: Record<string, SyncStore> = {};
    for (const storeName of Array.from(database.objectStoreNames).sort()) {
      if (!allowSensitive && isSensitiveSyncName(storeName)) continue;
      stores[storeName] = await exportStore(
        database,
        storeName,
        allowSensitive,
      );
    }
    return { stores };
  } finally {
    database.close();
  }
}

export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      forgetIndexedDBName(name);
      resolve();
    };
    request.onerror = () =>
      reject(syncError("indexeddb database deletion failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb database deletion blocked"));
  });
}
