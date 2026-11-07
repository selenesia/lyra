import { logicalDatabaseName } from "../../core/runtime/hosting.ts";
import type { CloudSync } from "./cloudsync.ts";
import { canSyncStorageValue, canSyncIndexedDBStore } from "./syncPolicy.ts";
import { SYNC_META_KEY } from "./syncMeta.ts";
import {
  rememberIndexedDBName,
  forgetIndexedDBName,
} from "./snapshotDatabases.ts";
const SYNC_DELAY = 750;

export function hookStorage(this: CloudSync): void {
  const markDirty = () => this.markDirty();
  if (typeof Storage !== "undefined") {
    const storage = Storage.prototype;
    const tracked = (value: Storage): boolean =>
      value === localStorage || value === sessionStorage;
    const originalSetItem = storage.setItem;
    storage.setItem = function (key: string, value: string): void {
      key = String(key);
      const previous = this.getItem(key);
      originalSetItem.call(this, key, value);
      if (
        tracked(this) &&
        previous !== String(value) &&
        (canSyncStorageValue(key, String(value)) ||
          (previous !== null && canSyncStorageValue(key, previous)))
      )
        markDirty();
    };

    const originalRemoveItem = storage.removeItem;
    storage.removeItem = function (key: string): void {
      key = String(key);
      const previous = this.getItem(key);
      originalRemoveItem.call(this, key);
      if (
        tracked(this) &&
        previous !== null &&
        canSyncStorageValue(key, previous)
      )
        markDirty();
    };

    const originalClear = storage.clear;
    storage.clear = function (): void {
      const hadValues = this.length > 0;
      originalClear.call(this);
      if (tracked(this) && hadValues) markDirty();
    };
  }

  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.storageArea === localStorage && e.key === SYNC_META_KEY) {
      try {
        if (e.newValue) this.syncMeta = JSON.parse(e.newValue);
      } catch {}
      return;
    }
    if (this.isRestoring) return;
    if (e.storageArea !== localStorage && e.storageArea !== sessionStorage)
      return;
    if (e.key === null) return markDirty();
    if (
      ![e.oldValue, e.newValue].some(
        (value) => value !== null && canSyncStorageValue(e.key!, value),
      )
    )
      return;
    markDirty();
  });

  if (typeof IDBObjectStore !== "undefined") {
    const observedTransactions = new WeakSet<IDBTransaction>();
    type IDBMutableMethod = "put" | "add" | "delete" | "clear";
    const hookIDB = (method: IDBMutableMethod): void => {
      const proto = IDBObjectStore.prototype as unknown as Record<
        string,
        unknown
      >;
      const original = proto[method] as (...args: unknown[]) => IDBRequest;
      if (!original) return;
      proto[method] = function (this: IDBObjectStore, ...args: unknown[]) {
        const request = original.apply(this, args);
        if (
          canSyncIndexedDBStore(logicalDatabaseName(this.transaction.db.name), this.name) &&
          !observedTransactions.has(this.transaction)
        ) {
          observedTransactions.add(this.transaction);
          this.transaction.addEventListener(
            "complete",
            () => markDirty(),
            { once: true },
          );
        }
        return request;
      };
    };
    hookIDB("put");
    hookIDB("add");
    hookIDB("delete");
    hookIDB("clear");
  }

  if (typeof IDBDatabase !== "undefined") {
    const databasePrototype = IDBDatabase.prototype;
    const originalCreateStore = databasePrototype.createObjectStore;
    databasePrototype.createObjectStore = function (...args) {
      markDirty();
      return originalCreateStore.apply(this, args);
    };
    const originalDeleteStore = databasePrototype.deleteObjectStore;
    databasePrototype.deleteObjectStore = function (...args) {
      markDirty();
      return originalDeleteStore.apply(this, args);
    };
  }

  if (typeof IDBFactory !== "undefined") {
    const originalOpenDatabase = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      const request = originalOpenDatabase.apply(this, args);
      request.addEventListener(
        "success",
        () => rememberIndexedDBName(logicalDatabaseName(String(args[0]))),
        { once: true },
      );
      return request;
    };
    const originalDeleteDatabase = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.deleteDatabase = function (...args) {
      const request = originalDeleteDatabase.apply(this, args);
      const name = logicalDatabaseName(String(args[0]));
      request.addEventListener(
        "success",
        () => forgetIndexedDBName(name),
        { once: true },
      );
      if (canSyncIndexedDBStore(name, "")) markDirty();
      return request;
    };
  }

  const browserCookieStore = (
    globalThis as unknown as {
      cookieStore?: {
        addEventListener?: (type: string, listener: () => void) => void;
      };
    }
  ).cookieStore;
  browserCookieStore?.addEventListener?.("change", () => markDirty());

  if (typeof Document !== "undefined") {
    const cookieDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "cookie",
    );
    if (cookieDescriptor?.get && cookieDescriptor.set) {
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: cookieDescriptor.configurable ?? false,
        enumerable: cookieDescriptor.enumerable ?? false,
        get: cookieDescriptor.get,
        set(value: string) {
          cookieDescriptor.set!.call(this, value);
          markDirty();
        },
      });
    }
  }
}

export function hookLifecycle(this: CloudSync): void {
  const flush = (): void => {
    if (this.isRestoring || (!this.isAuthenticated && !this.user.id)) return;
    this.markDirty();
    void this.syncData();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("pageshow", () => {
    if (this.syncMeta.dirty) void this.syncData();
  });
  window.addEventListener("online", () => {
    if (this.syncMeta.dirty) void this.syncData();
  });
}

export function scheduleSync(this: CloudSync, delay = SYNC_DELAY): void {
  if (this.syncTimeout !== null || this.isSyncing) return;
  this.syncTimeout = setTimeout(() => {
    this.syncTimeout = null;
    void this.syncData();
  }, delay);
}

export function markDirty(this: CloudSync): void {
  if (this.isRestoring || (!this.isAuthenticated && !this.user.id)) return;
  this._mutationVersion++;
  this.syncMeta.changed_at = Date.now();
  if (!this.syncMeta.dirty) {
    this.syncMeta.dirty = true;
    this.saveMeta();
  }

  this.updateStatus("syncing...", "loading");
  this.scheduleSync();
}
