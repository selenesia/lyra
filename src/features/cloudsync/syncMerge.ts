import type { SyncSnapshot } from "./snapshotSchema.ts";
import { FOLIO_DB } from "./syncPolicy.ts";

export type SnapshotIndex = Map<string, string>;

interface SnapshotItem {
  hash: string;
  value: unknown;
}

type SyncDatabase = SyncSnapshot["indexedDB"][string];
type SyncStore = SyncDatabase["stores"][string];
type SyncRecord = SyncStore["records"][number];
type SyncCookie = SyncSnapshot["cookies"][number];

const FOLIO_STORE = "state";
const FOLIO_COOKIE_KEY = JSON.stringify({ type: "string", value: "cookies" });

export function hashText(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^
    Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^
    Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(36)}.${(first >>> 0).toString(36)}`;
}

function itemId(...parts: string[]): string {
  return JSON.stringify(parts);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function folioCookies(record: SyncRecord): Record<string, unknown> | null {
  const value = record.value as unknown;
  if (!isObject(value) || value.type !== "object" || !isObject(value.value)) {
    return null;
  }
  const cookies = value.value.cookies;
  if (
    !isObject(cookies) ||
    cookies.type !== "string" ||
    typeof cookies.value !== "string"
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(cookies.value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function snapshotItems(snapshot: SyncSnapshot): Map<string, SnapshotItem> {
  const items = new Map<string, SnapshotItem>();
  const add = (id: string, value: unknown) =>
    items.set(id, { hash: hashText(JSON.stringify(value) ?? "null"), value });
  for (const [key, value] of Object.entries(snapshot.localStorage)) {
    add(itemId("l", key), value);
  }
  for (const [key, value] of Object.entries(snapshot.sessionStorage)) {
    add(itemId("s", key), value);
  }
  for (const cookie of snapshot.cookies) {
    add(
      itemId(
        "c",
        cookie.name,
        cookie.domain?.toLowerCase() ?? "",
        cookie.path,
        String(cookie.partitioned),
      ),
      cookie,
    );
  }
  for (const [databaseName, database] of Object.entries(snapshot.indexedDB)) {
    add(itemId("D", databaseName), null);
    for (const [storeName, store] of Object.entries(database.stores)) {
      add(itemId("d", databaseName, storeName), {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: store.indexes,
      });
      for (const record of store.records) {
        const keyId = JSON.stringify(record.key);
        if (
          databaseName === FOLIO_DB &&
          storeName === FOLIO_STORE &&
          keyId === FOLIO_COOKIE_KEY
        ) {
          const cookies = folioCookies(record);
          if (cookies) {
            add(itemId("F"), null);
            for (const [id, cookie] of Object.entries(cookies)) {
              add(itemId("f", id), cookie);
            }
            continue;
          }
        }
        add(itemId("r", databaseName, storeName, keyId), record);
      }
    }
  }
  return items;
}

export function snapshotIndex(snapshot: SyncSnapshot): SnapshotIndex {
  const index: SnapshotIndex = new Map();
  for (const [id, item] of snapshotItems(snapshot)) index.set(id, item.hash);
  return index;
}

function sortedObject<T>(entries: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries(
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function buildSnapshot(
  schemaVersion: SyncSnapshot["schemaVersion"],
  items: Map<string, unknown>,
): SyncSnapshot {
  const localStorage: Array<[string, string]> = [];
  const sessionStorage: Array<[string, string]> = [];
  const cookies: Array<[string, SyncCookie]> = [];
  const folio: Array<[string, unknown]> = [];
  let hasFolioCookies = false;
  const indexedDB: Record<string, SyncDatabase> = {};
  const records = new Map<string, Array<[string, SyncRecord]>>();
  const database = (name: string) => (indexedDB[name] ??= { stores: {} });
  for (const [id, value] of items) {
    const [kind, first = "", second = "", third = ""] = JSON.parse(id) as string[];
    if (kind === "l") localStorage.push([first, value as string]);
    else if (kind === "s") sessionStorage.push([first, value as string]);
    else if (kind === "c") cookies.push([id, value as SyncCookie]);
    else if (kind === "D") database(first);
    else if (kind === "d") {
      database(first).stores[second] = {
        ...(value as Omit<SyncStore, "records">),
        records: [],
      };
    } else if (kind === "r") {
      const storeId = itemId(first, second);
      if (!records.has(storeId)) records.set(storeId, []);
      records.get(storeId)!.push([third, value as SyncRecord]);
    } else if (kind === "F") hasFolioCookies = true;
    else if (kind === "f") folio.push([first, value]);
  }
  for (const [storeId, entries] of records) {
    const [databaseName, storeName] = JSON.parse(storeId) as [string, string];
    const store = indexedDB[databaseName]?.stores[storeName];
    if (!store) continue;
    store.records = Object.values(sortedObject(entries));
  }
  const folioStore = indexedDB[FOLIO_DB]?.stores[FOLIO_STORE];
  if (folioStore && (hasFolioCookies || folio.length)) {
    folioStore.records.push({
      key: { type: "string", value: "cookies" },
      value: {
        type: "object",
        id: 1,
        value: {
          cookies: {
            type: "string",
            value: JSON.stringify(sortedObject(folio)),
          },
          updatedAt: { type: "number", value: 0 },
        },
      },
    });
  }
  for (const entry of Object.values(indexedDB)) {
    entry.stores = sortedObject(Object.entries(entry.stores));
  }
  return {
    schemaVersion,
    localStorage: sortedObject(localStorage),
    sessionStorage: sortedObject(sessionStorage),
    cookies: Object.values(sortedObject(cookies)),
    indexedDB: sortedObject(Object.entries(indexedDB)),
  };
}

export interface MergeResult {
  snapshot: SyncSnapshot;
  localWins: number;
  remoteWins: number;
}

export function mergeSnapshots(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  base: SnapshotIndex | null,
  preferRemote: boolean,
): MergeResult {
  const localItems = snapshotItems(local);
  const remoteItems = snapshotItems(remote);
  const merged = new Map<string, unknown>();
  let localWins = 0;
  let remoteWins = 0;
  for (const id of new Set([...localItems.keys(), ...remoteItems.keys()])) {
    const localItem = localItems.get(id);
    const remoteItem = remoteItems.get(id);
    const baseHash = base?.get(id);
    let chosen: SnapshotItem | undefined;
    if (localItem?.hash === remoteItem?.hash) chosen = localItem;
    else if (!base && (!localItem || !remoteItem)) chosen = localItem ?? remoteItem;
    else if (base && localItem?.hash === baseHash) chosen = remoteItem;
    else if (base && remoteItem?.hash === baseHash) chosen = localItem;
    else chosen = preferRemote ? remoteItem : localItem;
    if (chosen?.hash !== remoteItem?.hash) localWins++;
    if (chosen?.hash !== localItem?.hash) remoteWins++;
    if (chosen) merged.set(id, chosen.value);
  }
  return {
    snapshot: buildSnapshot(local.schemaVersion, merged),
    localWins,
    remoteWins,
  };
}
