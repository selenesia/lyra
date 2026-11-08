import {
  isRecord,
  syncError,
} from "./snapshotValue.ts";
import {
  type SyncSnapshot,
  SYNC_SCHEMA_VERSION,
} from "./snapshotSchema.ts";
import {
  exportBrowserCookies,
  replaceCookies,
  applyCookieDelta,
} from "./snapshotCookies.ts";
import {
  exportStorage,
  replaceStorage,
  applyStorageDelta,
} from "./snapshotStorage.ts";
import { isSyncSnapshot } from "./snapshotSchema.ts";
import { databaseNames, exportDatabase } from "./snapshotDatabases.ts";
import {
  restoreIndexedDB,
  applyIndexedDBDelta,
} from "./snapshotDatabaseRestore.ts";
import { normalizeLegacySnapshot } from "./legacySnapshot.ts";
export {
  isLocalOnlySyncStorageKey,
  isSensitiveSyncName,
  canSyncIndexedDBStore,
  containsLocalOnlySiteData,
  canSyncStorageValue,
} from "./syncPolicy.ts";
export { payloadFingerprint } from "./snapshotPayload.ts";

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await task(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function exportSyncSnapshot(
  progress: (message: string) => void = () => {},
): Promise<SyncSnapshot> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  progress("reading local data...");
  const [names, cookies] = await Promise.all([
    databaseNames(factory),
    exportBrowserCookies(),
  ]);
  let read = 0;
  const databases = await mapConcurrent(names, 4, async (name) => {
    const database = await exportDatabase(factory, name);
    progress(`reading local data... (${++read}/${names.length})`);
    return [name, database] as const;
  });
  const indexedDB = Object.fromEntries(databases);
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    localStorage: exportStorage(globalThis.localStorage),
    sessionStorage: exportStorage(globalThis.sessionStorage),
    cookies,
    indexedDB,
  };
}

export async function importSyncSnapshot(
  value: unknown,
  progress: (message: string) => void = () => {},
): Promise<number> {
  const snapshot = isSyncSnapshot(value)
    ? value
    : isRecord(value) && value.schemaVersion === SYNC_SCHEMA_VERSION
      ? null
      : await normalizeLegacySnapshot(value);
  if (!snapshot || !isSyncSnapshot(snapshot)) {
    throw syncError("invalid sync snapshot");
  }
  const includeSensitive = snapshot.schemaVersion === SYNC_SCHEMA_VERSION;
  progress("restoring local storage...");
  let changes = replaceStorage(
    globalThis.localStorage,
    snapshot.localStorage,
    includeSensitive,
  );
  progress("restoring session storage...");
  changes += replaceStorage(
    globalThis.sessionStorage,
    snapshot.sessionStorage,
    includeSensitive,
  );
  progress("restoring cookies...");
  changes += await replaceCookies(snapshot.cookies);
  progress("restoring indexeddb...");
  changes += await restoreIndexedDB(
    snapshot.indexedDB,
    includeSensitive,
    (done, total) => progress(`restoring indexeddb... (${done}/${total})`),
  );
  return changes;
}

export async function applySyncDelta(
  previous: SyncSnapshot,
  target: unknown,
  progress: (message: string) => void = () => {},
): Promise<number> {
  if (
    !isSyncSnapshot(previous) ||
    !isSyncSnapshot(target) ||
    target.schemaVersion !== SYNC_SCHEMA_VERSION
  ) {
    return importSyncSnapshot(target, progress);
  }
  progress("restoring local storage...");
  let changes = applyStorageDelta(
    globalThis.localStorage,
    previous.localStorage,
    target.localStorage,
  );
  progress("restoring session storage...");
  changes += applyStorageDelta(
    globalThis.sessionStorage,
    previous.sessionStorage,
    target.sessionStorage,
  );
  progress("restoring cookies...");
  changes += await applyCookieDelta(previous.cookies, target.cookies);
  progress("restoring indexeddb...");
  changes += await applyIndexedDBDelta(
    previous.indexedDB,
    target.indexedDB,
    (done, total) => progress(`restoring indexeddb... (${done}/${total})`),
  );
  return changes;
}

export function changedDuringUpload(
  capturedVersion: number,
  currentVersion: number,
): boolean {
  return capturedVersion !== currentVersion;
}
