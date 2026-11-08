import {
  type SyncStore,
  type KeyPath,
  keyPath,
  type SyncDatabase,
  hasOwn,
  type SyncRecord,
  FOLIO_STORE,
  FOLIO_COOKIE_KEY,
  FOLIO_CHANNEL,
} from "./snapshotSchema.ts";
import {
  isSensitiveSyncName,
  allowsSensitiveDatabase,
  isSensitiveSyncText,
  isLocalOnlyRecord,
  canSyncIndexedDBStore,
  containsSensitiveTextValue,
  FOLIO_DB,
  LOCAL_ONLY_DATABASES,
} from "./syncPolicy.ts";
import {
  rememberIndexedDBName,
  openExistingDatabase,
  transactionDone,
  readRawRecords,
  encodeRecord,
  databaseNames,
  deleteDatabase,
} from "./snapshotDatabases.ts";
import {
  syncError,
  isRecord,
  encodeBrowserValue,
  decodeBrowserValue,
} from "./snapshotValue.ts";
import { mergeFolioCookieState } from "./folioCookies.ts";

function createStore(
  database: IDBDatabase,
  name: string,
  snapshot: SyncStore,
): IDBObjectStore {
  const options: IDBObjectStoreParameters = {
    autoIncrement: snapshot.autoIncrement,
  };
  if (snapshot.keyPath !== null) options.keyPath = snapshot.keyPath;
  const store = database.createObjectStore(name, options);
  for (const [indexName, index] of Object.entries(snapshot.indexes)) {
    store.createIndex(indexName, index.keyPath!, {
      unique: index.unique,
      multiEntry: index.multiEntry,
    });
  }
  return store;
}

function sameKeyPath(left: KeyPath, right: KeyPath): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStoreSchema(
  store: IDBObjectStore,
  snapshot: SyncStore,
  allowSensitive: boolean,
): boolean {
  if (
    !sameKeyPath(keyPath(store.keyPath), snapshot.keyPath) ||
    store.autoIncrement !== snapshot.autoIncrement
  ) {
    return false;
  }
  const names = Array.from(store.indexNames).filter(
    (name) => allowSensitive || !isSensitiveSyncName(name),
  );
  if (names.length !== Object.keys(snapshot.indexes).length) return false;
  return names.every((name) => {
    const expected = snapshot.indexes[name];
    if (!expected) return false;
    const index = store.index(name);
    return (
      sameKeyPath(keyPath(index.keyPath), expected.keyPath) &&
      index.unique === expected.unique &&
      index.multiEntry === expected.multiEntry
    );
  });
}

function openNewDatabase(
  factory: IDBFactory,
  name: string,
  snapshot: SyncDatabase,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [storeName, store] of Object.entries(snapshot.stores)) {
        createStore(request.result, storeName, store);
      }
    };
    request.onsuccess = () => {
      rememberIndexedDBName(name);
      resolve(request.result);
    };
    request.onerror = () =>
      reject(syncError("indexeddb database creation failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb database creation blocked"));
  });
}

async function reconcileDatabase(
  factory: IDBFactory,
  name: string,
  snapshot: SyncDatabase,
  exists: boolean,
  includeSensitive: boolean,
): Promise<{ database: IDBDatabase; changed: boolean }> {
  if (!exists) {
    return {
      database: await openNewDatabase(factory, name, snapshot),
      changed: true,
    };
  }
  const allowSensitive = includeSensitive && allowsSensitiveDatabase(name);
  let database = await openExistingDatabase(factory, name);
  const syncStores = Array.from(database.objectStoreNames).filter(
    (storeName) => allowSensitive || !isSensitiveSyncName(storeName),
  );
  let schemaMatches =
    syncStores.length === Object.keys(snapshot.stores).length &&
    syncStores.every((storeName) => hasOwn(snapshot.stores, storeName));
  if (schemaMatches && syncStores.length > 0) {
    const transaction = database.transaction(syncStores, "readonly");
    schemaMatches = syncStores.every((storeName) =>
      sameStoreSchema(
        transaction.objectStore(storeName),
        snapshot.stores[storeName]!,
        allowSensitive,
      ),
    );
  }
  if (schemaMatches) return { database, changed: false };

  const nextVersion = database.version + 1;
  database.close();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, nextVersion);
    request.onupgradeneeded = () => {
      const upgraded = request.result;
      for (const storeName of Array.from(upgraded.objectStoreNames)) {
        if (
          (allowSensitive || !isSensitiveSyncName(storeName)) &&
          !hasOwn(snapshot.stores, storeName)
        ) {
          upgraded.deleteObjectStore(storeName);
        }
      }
      for (const [storeName, storeSnapshot] of Object.entries(
        snapshot.stores,
      )) {
        if (upgraded.objectStoreNames.contains(storeName)) {
          const store = request.transaction!.objectStore(storeName);
          if (!sameStoreSchema(store, storeSnapshot, allowSensitive)) {
            upgraded.deleteObjectStore(storeName);
            createStore(upgraded, storeName, storeSnapshot);
          }
        } else {
          createStore(upgraded, storeName, storeSnapshot);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(syncError("indexeddb schema restore failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb schema restore blocked"));
  });
  return { database, changed: true };
}

function mergeLocalSecrets(remote: unknown, local: unknown): unknown {
  if (typeof local === "string" && isSensitiveSyncText(local)) return local;
  if (!isRecord(remote) || !isRecord(local)) return remote;
  for (const [key, localValue] of Object.entries(local)) {
    if (isSensitiveSyncName(key)) {
      remote[key] = localValue;
    } else if (hasOwn(remote, key)) {
      remote[key] = mergeLocalSecrets(remote[key], localValue);
    }
  }
  return remote;
}

async function sameStoredValue(left: unknown, right: unknown): Promise<boolean> {
  if (left === right) return true;
  try {
    return (
      JSON.stringify(await encodeBrowserValue(left, true)) ===
      JSON.stringify(await encodeBrowserValue(right, true))
    );
  } catch {
    return false;
  }
}

function syncableRecords(
  databaseName: string,
  storeName: string,
  records: SyncRecord[],
): SyncRecord[] {
  return records.filter(
    (record) =>
      !isLocalOnlyRecord(databaseName, storeName, decodeBrowserValue(record.key)),
  );
}

async function replaceRecords(
  database: IDBDatabase,
  databaseName: string,
  storeName: string,
  snapshot: SyncStore,
  includeSensitive: boolean,
): Promise<{ changes: number; folioUpdatedAt: number | null }> {
  if (!canSyncIndexedDBStore(databaseName, storeName)) {
    return { changes: 0, folioUpdatedAt: null };
  }
  const replaceSensitive =
    includeSensitive && allowsSensitiveDatabase(databaseName);
  const readTransaction = database.transaction(storeName, "readonly");
  const readDone = transactionDone(readTransaction);
  const localRecords = await readRawRecords(
    readTransaction.objectStore(storeName),
  );
  await readDone;

  const remoteRecords = syncableRecords(databaseName, storeName, snapshot.records).map(
    (record) => ({
      key: decodeBrowserValue(record.key) as IDBValidKey,
      keyId: JSON.stringify(record.key),
      value: decodeBrowserValue(record.value),
    }),
  );
  const remoteByKey = new Map(
    remoteRecords.map((record) => [record.keyId, record]),
  );
  const localByKey = new Map<string, (typeof localRecords)[number]>();
  for (const localRecord of localRecords) {
    const encodedKey = await encodeBrowserValue(
      localRecord.key,
      replaceSensitive,
    );
    const keyId = JSON.stringify(encodedKey);
    localByKey.set(keyId, localRecord);
    const remote = remoteByKey.get(keyId);
    if (remote && !replaceSensitive) {
      remote.value = mergeLocalSecrets(remote.value, localRecord.value);
    } else if (
      !remote &&
      (isLocalOnlyRecord(databaseName, storeName, localRecord.key) ||
        (await encodeRecord(
          databaseName,
          localRecord.key,
          localRecord.value,
          replaceSensitive,
        )) === null ||
        (!replaceSensitive &&
          (isSensitiveSyncName(String(localRecord.key)) ||
            (await containsSensitiveTextValue(localRecord.value, true)))))
    ) {
      remoteRecords.push({
        key: localRecord.key,
        keyId,
        value: localRecord.value,
      });
    }
  }

  let folioUpdatedAt: number | null = null;
  if (databaseName === FOLIO_DB && storeName === FOLIO_STORE) {
    const remote = remoteRecords.find(
      (record) => record.key === FOLIO_COOKIE_KEY,
    );
    const local = localRecords.find(
      (record) => record.key === FOLIO_COOKIE_KEY,
    );
    if (remote) {
      const merged = mergeFolioCookieState(
        remote.value,
        local?.value,
        replaceSensitive,
      ) as { updatedAt: number; cookies: string };
      const localCookies = isRecord(local?.value) ? local.value.cookies : null;
      if (local && localCookies === merged.cookies) {
        remote.value = local.value;
      } else {
        remote.value = merged;
        folioUpdatedAt = merged.updatedAt;
      }
    }
  }

  const remoteKeys = new Set(remoteRecords.map((record) => record.keyId));
  const deletes = [...localByKey]
    .filter(([keyId]) => !remoteKeys.has(keyId))
    .map(([, record]) => record.key);
  const puts: typeof remoteRecords = [];
  for (const record of remoteRecords) {
    const local = localByKey.get(record.keyId);
    if (!local || !(await sameStoredValue(local.value, record.value))) {
      puts.push(record);
    }
  }
  if (!deletes.length && !puts.length) return { changes: 0, folioUpdatedAt };

  const writeTransaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(writeTransaction);
  const store = writeTransaction.objectStore(storeName);
  for (const key of deletes) store.delete(key);
  for (const record of puts) {
    if (snapshot.keyPath === null) store.put(record.value, record.key);
    else store.put(record.value);
  }
  await done;
  return { changes: deletes.length + puts.length, folioUpdatedAt };
}

export async function restoreIndexedDB(
  remote: Record<string, SyncDatabase>,
  includeSensitive: boolean,
  progress: (done: number, total: number) => void = () => {},
): Promise<number> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  const currentNames = await databaseNames(factory);
  let changes = 0;
  for (const name of currentNames) {
    const replaceSensitive = includeSensitive && allowsSensitiveDatabase(name);
    if (
      (replaceSensitive || !isSensitiveSyncName(name)) &&
      !hasOwn(remote, name)
    ) {
      await deleteDatabase(factory, name);
      changes++;
    }
  }

  let folioUpdatedAt: number | null = null;
  const remoteDatabases = Object.entries(remote);
  let restored = 0;
  for (const [databaseName, databaseSnapshot] of remoteDatabases) {
    progress(++restored, remoteDatabases.length);
    if (LOCAL_ONLY_DATABASES.has(databaseName)) continue;
    const { database, changed } = await reconcileDatabase(
      factory,
      databaseName,
      databaseSnapshot,
      currentNames.includes(databaseName),
      includeSensitive,
    );
    if (changed) changes++;
    try {
      for (const [storeName, storeSnapshot] of Object.entries(
        databaseSnapshot.stores,
      )) {
        const restored = await replaceRecords(
          database,
          databaseName,
          storeName,
          storeSnapshot,
          includeSensitive,
        );
        changes += restored.changes;
        if (restored.folioUpdatedAt !== null) {
          folioUpdatedAt = restored.folioUpdatedAt;
        }
      }
    } finally {
      database.close();
    }
  }

  if (folioUpdatedAt !== null && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(FOLIO_CHANNEL);
    channel.postMessage({ updatedAt: folioUpdatedAt });
    channel.close();
  }
  return changes;
}

function sameStoreDefinition(
  left: SyncStore | undefined,
  right: SyncStore,
): boolean {
  return (
    left !== undefined &&
    sameKeyPath(left.keyPath, right.keyPath) &&
    left.autoIncrement === right.autoIncrement &&
    JSON.stringify(left.indexes) === JSON.stringify(right.indexes)
  );
}

interface RecordDelta {
  puts: Array<{ key: IDBValidKey; value: unknown }>;
  deletes: IDBValidKey[];
}

function recordDelta(
  previous: SyncStore | undefined,
  target: SyncStore,
): RecordDelta {
  const before = new Map(
    (previous?.records ?? []).map((record) => [JSON.stringify(record.key), record]),
  );
  const targetKeys = new Set<string>();
  const puts: RecordDelta["puts"] = [];
  for (const record of target.records) {
    const keyId = JSON.stringify(record.key);
    targetKeys.add(keyId);
    const prior = before.get(keyId);
    if (prior && JSON.stringify(prior.value) === JSON.stringify(record.value)) {
      continue;
    }
    puts.push({
      key: decodeBrowserValue(record.key) as IDBValidKey,
      value: decodeBrowserValue(record.value),
    });
  }
  const deletes: IDBValidKey[] = [];
  for (const [keyId, record] of before) {
    if (!targetKeys.has(keyId)) {
      deletes.push(decodeBrowserValue(record.key) as IDBValidKey);
    }
  }
  return { puts, deletes };
}

async function applyRecordDelta(
  database: IDBDatabase,
  databaseName: string,
  storeName: string,
  keyPath: KeyPath,
  delta: RecordDelta,
): Promise<number | null> {
  let folioUpdatedAt: number | null = null;
  const folioCookies =
    databaseName === FOLIO_DB && storeName === FOLIO_STORE
      ? delta.puts.find((record) => record.key === FOLIO_COOKIE_KEY)
      : undefined;
  if (folioCookies) {
    const readTransaction = database.transaction(storeName, "readonly");
    const readDone = transactionDone(readTransaction);
    const current = readTransaction.objectStore(storeName).get(FOLIO_COOKIE_KEY);
    await readDone;
    folioCookies.value = mergeFolioCookieState(
      folioCookies.value,
      current.result,
      true,
    );
    folioUpdatedAt = (folioCookies.value as { updatedAt: number }).updatedAt;
  }
  const transaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  for (const key of delta.deletes) store.delete(key);
  for (const record of delta.puts) {
    if (keyPath === null) store.put(record.value, record.key);
    else store.put(record.value);
  }
  await done;
  return folioUpdatedAt;
}

export async function applyIndexedDBDelta(
  previous: Record<string, SyncDatabase>,
  target: Record<string, SyncDatabase>,
  progress: (done: number, total: number) => void = () => {},
): Promise<number> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  let changes = 0;
  let folioUpdatedAt: number | null = null;
  for (const name of Object.keys(previous)) {
    if (hasOwn(target, name) || LOCAL_ONLY_DATABASES.has(name)) continue;
    await deleteDatabase(factory, name);
    changes++;
  }
  const currentNames = new Set(await databaseNames(factory));
  const targetDatabases = Object.entries(target);
  let applied = 0;
  for (const [name, snapshot] of targetDatabases) {
    progress(++applied, targetDatabases.length);
    if (LOCAL_ONLY_DATABASES.has(name)) continue;
    const prior = previous[name];
    const storeNames = Object.keys(snapshot.stores);
    const schemaUnchanged =
      prior !== undefined &&
      currentNames.has(name) &&
      storeNames.length === Object.keys(prior.stores).length &&
      storeNames.every((storeName) =>
        sameStoreDefinition(prior.stores[storeName], snapshot.stores[storeName]!),
      );
    if (!schemaUnchanged || !allowsSensitiveDatabase(name)) {
      const { database, changed } = await reconcileDatabase(
        factory,
        name,
        snapshot,
        currentNames.has(name),
        true,
      );
      if (changed) changes++;
      try {
        for (const [storeName, store] of Object.entries(snapshot.stores)) {
          const restored = await replaceRecords(database, name, storeName, store, true);
          changes += restored.changes;
          if (restored.folioUpdatedAt !== null) {
            folioUpdatedAt = restored.folioUpdatedAt;
          }
        }
      } finally {
        database.close();
      }
      continue;
    }
    const deltas = storeNames
      .filter((storeName) => canSyncIndexedDBStore(name, storeName))
      .map((storeName) => {
        const store = snapshot.stores[storeName]!;
        return {
          storeName,
          delta: recordDelta(prior.stores[storeName], {
            ...store,
            records: syncableRecords(name, storeName, store.records),
          }),
        };
      })
      .filter(({ delta }) => delta.puts.length || delta.deletes.length);
    if (!deltas.length) continue;
    const database = await openExistingDatabase(factory, name);
    try {
      for (const { storeName, delta } of deltas) {
        const updatedAt = await applyRecordDelta(
          database,
          name,
          storeName,
          snapshot.stores[storeName]!.keyPath,
          delta,
        );
        changes += delta.puts.length + delta.deletes.length;
        if (updatedAt !== null) folioUpdatedAt = updatedAt;
      }
    } finally {
      database.close();
    }
  }
  if (folioUpdatedAt !== null && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(FOLIO_CHANNEL);
    channel.postMessage({ updatedAt: folioUpdatedAt });
    channel.close();
  }
  return changes;
}
