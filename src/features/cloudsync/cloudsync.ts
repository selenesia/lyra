import {
  uploadSnapshot,
  uploadSealedSnapshot,
  downloadSnapshot,
} from "./syncTransfer.ts";
import {
  PASSWORD_IDLE_TEXT,
  USERNAME_AVAILABLE_TEXT,
  USERNAME_CHECKING_TEXT,
  USERNAME_IDLE_TEXT,
  USERNAME_TAKEN_TEXT,
  USERNAME_UNCHECKED_TEXT,
  passwordHint,
  passwordSubmitError,
  setFieldHint,
  usernameHint,
  usernameSubmitError,
} from "./accountFields.ts";
import {
  AccountAuthError,
  createAccount,
  signIn,
  type AccountFailure,
} from "./accountAuth.ts";
import { prepareSnapshot } from "./prepareSnapshot.ts";
import type { SnapshotPayload } from "./snapshotPayload.ts";
import {
  canEncryptSync,
  forgetSyncKeys,
  keysFromMaster,
  loadSyncKeys,
  saveSyncKeys,
  type SyncBytes,
  type SyncKeys,
} from "./syncCrypto.ts";
import {
  mergeSnapshots,
  snapshotIndex,
  type SnapshotIndex,
} from "./syncMerge.ts";
import { readLocalState, writeLocalState } from "./syncLocalState.ts";
import { SYNC_LOCAL_DATABASE } from "./syncPolicy.ts";
import { svgIcon } from "../../core/ui/svgIcon";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { appServiceWorkers, logicalDatabaseName, isStatic } from "../../core/runtime/hosting.ts";
import type { ToastController } from "../../core/ui/toast.ts";
import {
  closeManagedModal,
  isManagedModalOpen,
  openManagedModal,
} from "../../core/ui/modal.ts";
import {
  applySyncDelta,
  changedDuringUpload,
  canSyncIndexedDBStore,
  canSyncStorageValue,
  forgetIndexedDBName,
  rememberIndexedDBName,
  type SyncSnapshot,
} from "./syncSnapshot.ts";

interface SyncMeta {
  dirty: boolean;
  last_synced: string | null;
  fingerprint?: string | null;
  changed_at?: number | null;
}

interface SyncBase {
  revision: string;
  index: SnapshotIndex;
}

interface AuthUser {
  username?: string;
  id?: string | number;
  sync_salt?: string;
  [key: string]: unknown;
}

interface SessionData {
  user: AuthUser;
  [key: string]: unknown;
}

interface LocalExport {
  snapshot: SyncSnapshot;
  prepared: SnapshotPayload;
}

declare global {
  interface Window {
    lyraExportAllData?: () => Promise<SyncSnapshot>;
    lyraImportDataFromObject?: (
      data: unknown,
      callback?: (progressText: string) => void,
    ) => Promise<number>;
    bypassPreventClosing?: boolean;
  }
}

const POLL_INTERVAL = 20000;
const POLL_MAX_INTERVAL = 60000;
const SYNC_DELAY = 750;
const SCAN_COST_FACTOR = 40;
const SCAN_MAX_INTERVAL = 5 * 60_000;
const FOLLOW_UP_THRESHOLD = 1000;
const FOLLOW_UP_MAX = 30_000;
const SYNC_LOCK = "lyra-cloudsync";
const SYNC_META_KEY = "lyra-sync-meta";
const LOCKED_STATUS = "sync is locked; enter your password... /ᐠ - ˕ -マ";
const TOO_MANY_ATTEMPTS_TEXT =
  "too many attempts; wait a moment and try again... /ᐠ - ˕ -マ";
const SECURE_CONNECTION_TEXT =
  "sign in needs a secure (https) connection... /ᐠ - ˕ -マ";

const LOADING_SCREEN = `
    <div id="loading-screen" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--bg-body); z-index: 99999; display: flex; justify-content: center; align-items: center; color: var(--text-muted); font-family: 'Lexend', sans-serif;">
        <h1 style="margin: 0; font-size: 1.2rem; font-weight: 300;">syncing data...</h1>
    </div>
`;

function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    credentials: "same-origin",
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(id));
}

function authFailure(error: unknown): AccountFailure | null {
  return error instanceof AccountAuthError ? error.failure : null;
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function revisionTime(revision: string): number {
  return Date.parse(revision.slice(0, 24));
}

function isCurrentSnapshot(value: unknown): value is SyncSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === 3
  );
}

function sameIndex(
  left: SnapshotIndex | undefined,
  right: SnapshotIndex,
): boolean {
  if (!left || left.size !== right.size) return false;
  for (const [id, hash] of right) {
    if (left.get(id) !== hash) return false;
  }
  return true;
}

async function responseCode(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json();
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = (
    globalThis.navigator as { locks?: LockManager } | undefined
  )?.locks;
  return typeof locks?.request === "function"
    ? (locks.request(SYNC_LOCK, task) as Promise<T>)
    : task();
}

export class CloudSync {
  user: AuthUser;
  syncMeta: SyncMeta;
  syncTimeout: ReturnType<typeof setTimeout> | null;
  isSyncing: boolean;
  isAuthenticated: boolean;
  isRestoring: boolean;
  keys: SyncKeys | null;
  locked: boolean;
  usernameAvailability: Map<string, boolean> = new Map();
  _lastStatusText: string | undefined;
  _statusText: string | undefined;
  _lastStatusType: string | undefined;
  _mutationVersion: number;
  _pollInterval: number;
  _checkIntervalId: ReturnType<typeof setInterval> | null;
  _lastScan: number;
  _scanInterval: number;
  _lastCycleMs: number;
  _lockNotified: boolean;

  constructor() {
    try {
      const storedUser = JSON.parse(localStorage.getItem("auth_user") || "{}");
      this.user =
        typeof storedUser === "object" && storedUser !== null ? storedUser : {};
    } catch {
      this.user = {};
    }
    try {
      this.syncMeta = JSON.parse(
        localStorage.getItem(SYNC_META_KEY) ||
          '{"dirty": false, "last_synced": null}',
      );
    } catch (e) {
      this.syncMeta = { dirty: false, last_synced: null };
    }

    this.syncTimeout = null;
    this.isSyncing = false;
    this.isAuthenticated = false;
    this.isRestoring = false;
    this.keys = null;
    this.locked = false;
    this._lastStatusText = undefined;
    this._statusText = undefined;
    this._lastStatusType = undefined;
    this._mutationVersion = 0;
    this._pollInterval = POLL_INTERVAL;
    this._checkIntervalId = null;
    this._lastScan = 0;
    this._scanInterval = POLL_INTERVAL;
    this._lastCycleMs = 0;
    this._lockNotified = false;

    this.init();
  }

  async init(): Promise<void> {
    if (isStatic) {
      this.user = {};
      localStorage.removeItem("auth_user");
      return;
    }
    this.hookStorage();
    this.hookLifecycle();
    let ready = false;
    let togglePending = false;
    document.addEventListener("toggleCloudSyncModal", () => {
      if (!ready) {
        togglePending = !togglePending;
        return;
      }
      void this.toggleCloudSyncModal();
    });
    let needsLoadingScreen = false;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      await this.applyAuthResponse(
        await fetchWithTimeout("/api/auth/me", { cache: "no-store" }),
      );

      if (this.isAuthenticated) {
        this.keys = await loadSyncKeys(this.user.id);
        const serverUpdatedAt = await this.remoteRevision();
        if (serverUpdatedAt === null) {
          throw new Error(negativeMessage("sync metadata unavailable"));
        }

        if (serverUpdatedAt && serverUpdatedAt !== this.syncMeta.last_synced) {
          needsLoadingScreen = true;
          this.showLoadingScreen();
          safetyTimer = setTimeout(() => this.hideLoadingScreen(), 10000);
          await this.restoreData(true);
        } else if (this.syncMeta.dirty || !serverUpdatedAt) {
          this.syncMeta.dirty = true;
          this.saveMeta();
          await this.syncData(!serverUpdatedAt);
        } else {
          this.updateStatus("synced!! (˵◝ ⩊  ◜˵マ", "success");
        }
      }
    } catch {
      console.warn("[cloudsync] startup check failed... /ᐠ - ˕ -マ");
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      if (needsLoadingScreen) this.hideLoadingScreen();
    }

    ready = true;
    if (togglePending) void this.toggleCloudSyncModal();
    if (this.isAuthenticated && !this.locked) {
      this.startPolling();
      void this.poll();
    }
  }

  startPolling(): void {
    this.stopPolling();
    this._checkIntervalId = setInterval(() => {
      void this.poll();
    }, this._pollInterval);
  }

  stopPolling(): void {
    if (this._checkIntervalId) {
      clearInterval(this._checkIntervalId);
      this._checkIntervalId = null;
    }
  }

  onSyncError(): void {
    this._pollInterval = Math.min(this._pollInterval * 2, POLL_MAX_INTERVAL);
    this.startPolling();
  }

  onSyncSuccess(): void {
    if (this._pollInterval > POLL_INTERVAL) {
      this._pollInterval = POLL_INTERVAL;
      this.startPolling();
    }
  }

  async remoteRevision(): Promise<string | null> {
    try {
      const response = await fetchWithTimeout("/api/sync/meta", {
        cache: "no-store",
      });
      if (response.status === 401) {
        await this.checkAuthStatus();
        return null;
      }
      if (!response.ok) return null;
      const meta = await response.json();
      return typeof meta?.updated_at === "string" ? meta.updated_at : "";
    } catch {
      return null;
    }
  }

  scanDue(): boolean {
    return Date.now() - (this._lastScan ?? 0) >= (this._scanInterval ?? POLL_INTERVAL);
  }

  async sync(manual: boolean = false): Promise<void> {
    try {
      if (!this.isAuthenticated || this.isSyncing || this.isRestoring) return;
      if (this.locked) {
        this.updateStatus(LOCKED_STATUS, "error");
        return;
      }
      if (globalThis.navigator?.onLine === false) return;
      const serverUpdatedAt = await this.remoteRevision();
      if (serverUpdatedAt === null) return;

      if (serverUpdatedAt && serverUpdatedAt !== this.syncMeta.last_synced) {
        await this.restoreData(true);
      } else if (this.syncMeta.dirty || !serverUpdatedAt || manual) {
        this.syncMeta.dirty = true;
        this.saveMeta();
        await this.syncData(manual || !serverUpdatedAt);
      } else if (this.scanDue()) {
        await this.syncData();
      } else {
        this.updateStatus("synced!! (˵◝ ⩊  ◜˵マ", "success");
      }
    } catch {
      console.warn("[cloudsync] sync failed... /ᐠ - ˕ -マ");
    }
  }

  showLoadingScreen(): void {
    if (!document.getElementById("loading-screen")) {
      const div = document.createElement("div");
      div.innerHTML = LOADING_SCREEN.trim();
      document.body.appendChild(div.firstChild!);
    }
  }

  hideLoadingScreen(): void {
    const screen = document.getElementById("loading-screen");
    if (screen) {
      screen.remove();
    }
  }

  async applyAuthResponse(response: Response): Promise<void> {
    if (response.ok) {
      const authPayload = await response.json();
      this.user = authPayload.user;
      this.isAuthenticated = true;
      localStorage.setItem("auth_user", JSON.stringify(this.user));
    } else {
      this.isAuthenticated = false;
      this.user = {};
      localStorage.removeItem("auth_user");
    }
    this.updateModalState();
  }

  async checkAuthStatus(): Promise<void> {
    try {
      await this.applyAuthResponse(
        await fetchWithTimeout("/api/auth/me", { cache: "no-store" }),
      );
    } catch {
      console.warn("auth check failed... /ᐠ - ˕ -マ");
      this.isAuthenticated = false;
    }
  }

  saveMeta(): void {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(this.syncMeta));
  }

  baseKey(): string | null {
    const id = this.user?.id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  }

  async loadBase(): Promise<SyncBase | null> {
    const key = this.baseKey();
    if (!key) return null;
    const base = await readLocalState<SyncBase>("base", key);
    return base && typeof base.revision === "string" && base.index instanceof Map
      ? base
      : null;
  }

  async saveBase(revision: string, index: SnapshotIndex | undefined): Promise<void> {
    const key = this.baseKey();
    if (key && index) await writeLocalState("base", key, { revision, index });
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) {
      this.stopPolling();
      this.updateStatus(LOCKED_STATUS, "error");
      if (!this._lockNotified && window.showToast) {
        this._lockNotified = true;
        window.showToast(
          "error",
          "open cloud sync and enter your password to keep syncing... /ᐠ - ˕ -マ",
          "IconExclamationTriangle",
        );
      }
    } else if (this.isAuthenticated) {
      this.startPolling();
    }
    this.updateModalState();
  }

  async adoptKeys(master: SyncBytes): Promise<void> {
    if (!canEncryptSync()) {
      this.keys = null;
      return;
    }
    try {
      const keys = await keysFromMaster(master);
      await saveSyncKeys(this.user.id, keys);
      this.keys = keys;
      this.locked = false;
    } catch {
      this.keys = null;
      console.warn("[cloudsync] encryption key setup failed... /ᐠ - ˕ -マ");
    }
  }

  async exportLocal(): Promise<LocalExport> {
    const exporter = window.lyraExportAllData;
    if (typeof exporter !== "function") {
      throw new Error(negativeMessage("export boundary unavailable"));
    }
    const started = now();
    const snapshot = await exporter();
    const prepared = await prepareSnapshot({
      snapshot,
      keys: this.keys ?? null,
    });
    this._lastScan = Date.now();
    this._scanInterval = Math.min(
      SCAN_MAX_INTERVAL,
      Math.max(POLL_INTERVAL, (now() - started) * SCAN_COST_FACTOR),
    );
    return { snapshot, prepared };
  }

  remoteIsNewer(revision: string): boolean {
    const remote = revisionTime(revision);
    return !Number.isFinite(remote) || remote >= (this.syncMeta.changed_at ?? 0);
  }

  hookStorage(): void {
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

  hookLifecycle(): void {
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

  scheduleSync(delay = SYNC_DELAY): void {
    if (this.syncTimeout !== null || this.isSyncing) return;
    this.syncTimeout = setTimeout(() => {
      this.syncTimeout = null;
      void this.syncData();
    }, delay);
  }

  markDirty(): void {
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

  async checkForChanges(): Promise<void> {
    if (!this.isAuthenticated || this.isSyncing || this.isRestoring) {
      return;
    }
    await this.syncData();
  }

  async poll(): Promise<void> {
    await this.sync();
  }

  async syncData(
    manual: boolean = false,
    retryCount: number = 0,
  ): Promise<void> {
    if (!this.isAuthenticated || this.isSyncing || this.isRestoring) return;
    if (this.locked) {
      this.updateStatus(LOCKED_STATUS, "error");
      return;
    }
    if (this.syncTimeout !== null) clearTimeout(this.syncTimeout);
    this.syncTimeout = null;
    this.isSyncing = true;
    let acknowledged = false;
    let conflicted = false;
    const started = now();

    try {
      if (typeof window.lyraExportAllData !== "function") {
        if (retryCount >= 3) {
          console.warn(
            "[cloudsync] export boundary unavailable after retries... /ᐠ - ˕ -マ",
          );
          this.isSyncing = false;
          this.updateStatus("sync skipped... /ᐠ - ˕ -マ", "error");
          this.onSyncError();
          return;
        }
        console.warn(
          `[cloudsync] export boundary unavailable; retry ${retryCount + 1}/3... /ᐠ - ˕ -マ`,
        );
        this.isSyncing = false;
        setTimeout(() => this.syncData(manual, retryCount + 1), 2000);
        return;
      }

      await withSyncLock(async () => {
        const snapshotVersion = this._mutationVersion;
        const { prepared } = await this.exportLocal();
        const { fingerprint } = prepared;

        const unchanged =
          !manual &&
          this.syncMeta.last_synced !== null &&
          fingerprint === this.syncMeta.fingerprint;
        this.syncMeta.dirty = true;
        this.saveMeta();
        const options = { base: this.syncMeta.last_synced ?? "" };
        const response = unchanged
          ? null
          : this.keys && prepared.sealed
            ? await uploadSealedSnapshot(
                prepared.body,
                prepared.sealed,
                this.keys,
                options,
              )
            : await uploadSnapshot(prepared.body, options);

        if (response === null || response.ok) {
          const uploadResult = response === null ? null : await response.json();
          acknowledged = true;
          const uploadWasStale = changedDuringUpload(
            snapshotVersion,
            this._mutationVersion,
          );
          this.syncMeta.dirty = uploadWasStale;
          this.syncMeta.fingerprint = fingerprint;
          if (!uploadWasStale) this.syncMeta.changed_at = null;
          if (uploadResult) {
            this.syncMeta.last_synced =
              uploadResult.updated_at ||
              new Date().toISOString().replace("T", " ").slice(0, 19);
            await this.saveBase(this.syncMeta.last_synced!, prepared.index);
          }
          this.saveMeta();

          this.updateStatus(
            uploadWasStale ? "syncing..." : "synced!! (˵◝ ⩊  ◜˵マ",
            uploadWasStale ? "loading" : "success",
          );
          this.onSyncSuccess();
          return;
        }

        const code = await responseCode(response);
        console.warn(
          `[cloudsync] upload failed with status ${response.status}... /ᐠ - ˕ -マ`,
        );
        if (response.status === 409 && code === "sync_revision_conflict") {
          conflicted = true;
          this.updateStatus("syncing...", "loading");
        } else if (response.status === 423) {
          this.setLocked(true);
        } else if (response.status === 401) {
          await this.checkAuthStatus();
          this.stopPolling();
          this.updateStatus("sign in again to sync... /ᐠ - ˕ -マ", "error");
        } else if (response.status === 413) {
          this.updateStatus("sync data is too large... /ᐠ - ˕ -マ", "error");
        } else if (response.status === 400 || response.status === 422) {
          this.updateStatus(
            "some browser data could not be synced... /ᐠ - ˕ -マ",
            "error",
          );
        } else {
          this.updateStatus("sync failed... /ᐠ - ˕ -マ", "error");
        }
        if (this.isAuthenticated && !conflicted && !this.locked) {
          this.onSyncError();
        }
      });
    } catch {
      console.error("sync failed... /ᐠ - ˕ -マ");
      this.updateStatus("connection error... /ᐠ - ˕ -マ", "error");
      this.onSyncError();
    } finally {
      this.isSyncing = false;
      this._lastCycleMs = now() - started;
      if (conflicted) {
        void this.restoreData(true);
      } else if (acknowledged && this.syncMeta.dirty) {
        this.scheduleSync(
          this._lastCycleMs > FOLLOW_UP_THRESHOLD
            ? Math.min(FOLLOW_UP_MAX, this._lastCycleMs * 2)
            : 0,
        );
      }
    }
  }

  async restoreData(
    silent: boolean = false,
    replace: boolean = false,
  ): Promise<void> {
    if (!this.isAuthenticated) return;
    if (this.isRestoring) return;
    if (!silent) this.updateStatus("restoring...", "loading");
    this.isRestoring = true;

    let restoreToast: ToastController | null = null;
    let reloading = false;
    let followUp = false;

    if (!silent && window.showToast) {
      restoreToast = window.showToast(
        "info",
        "restoring data...",
        "IconArrowRotateClockwise",
        0,
      );
    }

    try {
      await withSyncLock(async () => {
        const local = replace ? null : await this.exportLocal();
        const response = await downloadSnapshot({
          keys: this.keys ?? null,
          local: local?.prepared.sealed
            ? { body: local.prepared.body, chunks: local.prepared.sealed.chunks }
            : null,
        });

        if (response.status === 423) {
          if ((await responseCode(response)) === "sync_key_mismatch") {
            this.keys = null;
            await forgetSyncKeys(this.user.id);
          }
          this.setLocked(true);
          return;
        }

        if (response.status === 429 || response.status >= 500) {
          if (!silent) {
            this.updateStatus("sync service busy... /ᐠ - ˕ -マ", "error");
          }
          return;
        }

        if (!response.ok && response.status !== 404) {
          if (!silent) {
            this.updateStatus("restore failed... /ᐠ - ˕ -マ", "error");
          }
          return;
        }

        const syncPayload = await response.json();

        if (response.ok && syncPayload.data) {
          const importer = window.lyraImportDataFromObject;
          if (typeof importer !== "function") return;
          const remote: unknown = syncPayload.data;
          const revision: string = syncPayload.updated_at;
          let target: unknown = remote;
          let localWins = 0;
          if (local && isCurrentSnapshot(remote)) {
            const base = await this.loadBase();
            const usableBase =
              base && base.revision === this.syncMeta.last_synced
                ? base.index
                : null;
            if (usableBase || this.syncMeta.dirty) {
              const merged = mergeSnapshots(
                local.snapshot,
                remote,
                usableBase,
                this.remoteIsNewer(revision),
              );
              target = merged.snapshot;
              localWins = merged.localWins;
            }
          }
          const progress = (progressText: string) => {
            const loadingH1 =
              document.querySelector<HTMLElement>("#loading-screen h1");
            if (loadingH1) loadingH1.textContent = progressText;
          };
          const changes = local
            ? await applySyncDelta(local.snapshot, target, progress)
            : await importer(target, progress);

          this.syncMeta.last_synced = revision;
          if (isCurrentSnapshot(remote)) {
            await this.saveBase(revision, snapshotIndex(remote));
          }
          let pending = localWins > 0;
          if (changes > 0 || !local) {
            const after = await this.exportLocal();
            this.syncMeta.fingerprint = after.prepared.fingerprint;
            pending ||=
              local !== null &&
              isCurrentSnapshot(target) &&
              !sameIndex(after.prepared.index, snapshotIndex(target));
          } else {
            this.syncMeta.fingerprint = local.prepared.fingerprint;
          }
          this.syncMeta.dirty = pending;
          if (pending) this.syncMeta.fingerprint = null;
          this.saveMeta();

          if (changes > 0) {
            document.dispatchEvent(new CustomEvent("cloudsync-restored"));
            reloading = true;
            window.bypassPreventClosing = true;
            window.location.reload();
          } else if (pending) {
            followUp = true;
          } else {
            this.updateStatus("synced!! (˵◝ ⩊  ◜˵マ", "success");
          }
        } else if (response.status === 404) {
          this.syncMeta.dirty = true;
          this.syncMeta.last_synced = null;
          this.saveMeta();
          this.updateStatus("syncing...", "loading");
          followUp = true;
        }
      });
    } catch {
      console.error("restore failed... /ᐠ - ˕ -マ");
      if (!silent) {
        this.updateStatus("restore failed... /ᐠ - ˕ -マ", "error");
      }
    } finally {
      this.isRestoring = false;
      if (restoreToast && !reloading) {
        restoreToast.hide();
      }
      if (followUp && !reloading) setTimeout(() => void this.syncData(true), 0);
    }
  }

  async createCloudSyncModal(): Promise<void> {
    if (isStatic || document.getElementById("cloudsync-modal")) return;

    const modal = document.createElement("div");
    modal.id = "cloudsync-modal";
    modal.className = "popup";
    modal.innerHTML = `
                <h2 id="auth-title">login</h2>
                <div id="auth-forms" class="input-container">
                    <form id="login-form">
                        <label>username</label>
                        <input type="text" id="login-username" placeholder="enter username" autocomplete="username" minlength="3" maxlength="20">

                        <label style="margin-top: 15px;">password</label>
                        <div style="position: relative;">
                            <input type="password" id="login-password" placeholder="enter password" autocomplete="current-password" maxlength="128" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <span class="password-toggle" data-target="login-password" style="position: absolute; right: 10px; top: 0; bottom: 5px; display: flex; align-items: center; cursor: pointer; color: var(--text-muted); font-size: 13px;">${svgIcon("IconEyeOpen")}</span>
                        </div>

                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 50%; margin-top: 15px;">login</button>
                        </div>
                    </form>

                    <form id="register-form" style="display: none;" novalidate>
                        <label>username</label>
                        <input type="text" id="reg-username" placeholder="create username" autocomplete="username" maxlength="20" autocapitalize="none" spellcheck="false" aria-describedby="reg-username-feedback">
                        <div id="reg-username-feedback" class="auth-field-hint" data-tone="neutral" aria-live="polite">${USERNAME_IDLE_TEXT}</div>

                        <label style="margin-top: 20px;">password</label>
                        <div style="position: relative;">
                            <input type="password" id="reg-password" placeholder="create password" autocomplete="new-password" maxlength="128" aria-describedby="reg-password-feedback" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <span class="password-toggle" data-target="reg-password" style="position: absolute; right: 10px; top: 0; bottom: 5px; display: flex; align-items: center; cursor: pointer; color: var(--text-muted); font-size: 13px;">${svgIcon("IconEyeOpen")}</span>
                        </div>
                        <div id="reg-password-feedback" class="auth-field-hint" data-tone="neutral" aria-live="polite">${PASSWORD_IDLE_TEXT}</div>

                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 60%; margin-top: 15px;">create account</button>
                            <p style="font-size: 12px; color: var(--status-error-text); margin-top: 10px; max-width: 80%; margin-left: auto; margin-right: auto;">
              save your password somewhere safe; all data will be forever lost if you forget it... /ᐠ - ˕ -マ
                            </p>
                        </div>
                    </form>

                    <div style="margin-top: 15px; margin-bottom: -20px; font-size: 13px; color: var(--text-muted); text-align: center;" id="auth-switch-container">
                        <span id="auth-prompt-text">don't have an account?</span> <span id="auth-action-text" class="link">create one!</span>
                    </div>
                    <div id="auth-error" style="color: var(--status-error-text); margin-top: 10px; font-size: 13px; min-height: 18px; text-align: center;"></div>
                </div>
                <div id="auth-logged-in" style="display: none; text-align: center;">
                    <p style="margin-bottom: 20px; font-size: 16px;">logged in as <span id="auth-user-display" style="color: var(--text-white);"></span></p>

                    <div style="margin-bottom: 20px;">
                        <span id="sync-status-indicator" style="color: var(--text-muted); font-size: 14px;">
                            ${this._statusText ?? "synced!! (˵◝ ⩊  ◜˵マ"}
                        </span>
                        <div id="sync-encryption-status" style="color: var(--text-muted); font-size: 12px; margin-top: 6px;"></div>
                    </div>

                    <form id="unlock-form" class="input-container" style="display: none; margin-bottom: 15px;">
                        <input type="password" id="unlock-password" placeholder="enter password" autocomplete="current-password" maxlength="128">
                        <button type="submit" id="unlock-btn" class="auth-action-btn" style="width: 60%; margin-top: 10px;">encrypt sync</button>
                    </form>

                    <button id="sync-now-btn" class="auth-action-btn auth-secondary-btn">
                        sync now
                    </button>

                    <button id="logout-btn" class="auth-action-btn auth-secondary-btn">
                        logout
                    </button>

                    <button id="delete-account-btn" class="auth-action-btn auth-secondary-btn">
                        delete account
                    </button>
                </div>
            <button id="close-cloudsync-modal" class="modal-close-btn" aria-label="close">
                ${svgIcon("IconCrossMedium")}
            </button>
        `;

    document.body.appendChild(modal);
    this.attachCloudSyncModalListeners(modal);
    this.updateModalState();
  }

  attachCloudSyncModalListeners(modal: HTMLElement): void {
    (
      modal.querySelector("#close-cloudsync-modal") as HTMLElement
    ).addEventListener("click", () => this.toggleCloudSyncModal());
    const loginForm = modal.querySelector<HTMLFormElement>("#login-form")!;
    const regForm = modal.querySelector<HTMLFormElement>("#register-form")!;

    const regUsername = modal.querySelector<HTMLInputElement>("#reg-username")!;
    const regUsernameFeedback = modal.querySelector<HTMLElement>(
      "#reg-username-feedback",
    )!;
    const regPassword = modal.querySelector<HTMLInputElement>("#reg-password")!;
    const regPasswordFeedback = modal.querySelector<HTMLElement>(
      "#reg-password-feedback",
    )!;

    let usernameCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let usernameCheckAbort: AbortController | null = null;

    const showUsernameAvailability = (available: boolean | null) => {
      if (available === null) {
        setFieldHint(regUsernameFeedback, "neutral", USERNAME_UNCHECKED_TEXT);
      } else if (available) {
        setFieldHint(regUsernameFeedback, "success", USERNAME_AVAILABLE_TEXT);
      } else {
        setFieldHint(regUsernameFeedback, "error", USERNAME_TAKEN_TEXT);
      }
    };

    regUsername.addEventListener("input", () => {
      clearTimeout(usernameCheckTimer);
      usernameCheckAbort?.abort();
      usernameCheckAbort = null;

      const username = regUsername.value;
      const hint = usernameHint(username);
      if (!hint.valid) {
        setFieldHint(regUsernameFeedback, hint.tone, hint.text);
        return;
      }

      const known = this.usernameAvailability.get(username);
      if (known !== undefined) {
        showUsernameAvailability(known);
        return;
      }

      setFieldHint(regUsernameFeedback, "neutral", USERNAME_CHECKING_TEXT);
      usernameCheckTimer = setTimeout(async () => {
        const controller = new AbortController();
        usernameCheckAbort = controller;
        const available = await this.fetchUsernameAvailability(
          username,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        showUsernameAvailability(available);
      }, 350);
    });

    regPassword.addEventListener("input", () => {
      const hint = passwordHint(regPassword.value);
      setFieldHint(regPasswordFeedback, hint.tone, hint.text);
    });

    const promptText = modal.querySelector<HTMLElement>("#auth-prompt-text")!;
    const actionText = modal.querySelector<HTMLElement>("#auth-action-text")!;
    const authTitle = modal.querySelector<HTMLElement>("#auth-title")!;

    const loginUsername =
      modal.querySelector<HTMLInputElement>("#login-username")!;
    const loginPassword =
      modal.querySelector<HTMLInputElement>("#login-password")!;

    actionText.addEventListener("click", () => {
      const isLogin = loginForm.style.display !== "none";
      if (isLogin) {
        regUsername.value = loginUsername.value;
        regPassword.value = "";
        regUsername.dispatchEvent(new Event("input"));
        regPassword.dispatchEvent(new Event("input"));
        loginForm.style.display = "none";
        regForm.style.display = "block";
        authTitle.textContent = "create account";
        promptText.textContent = "already have an account?";
        actionText.textContent = "login!";
        (regUsername.value ? regPassword : regUsername).focus();
      } else {
        loginUsername.value = regUsername.value;
        loginPassword.value = "";
        loginForm.style.display = "block";
        regForm.style.display = "none";
        authTitle.textContent = "login";
        promptText.textContent = "don't have an account?";
        actionText.textContent = "create one!";
        (loginUsername.value ? loginPassword : loginUsername).focus();
      }
      this.showError("");
    });

    loginForm.addEventListener("submit", (e) => this.handleLogin(e));
    regForm.addEventListener("submit", (e) => this.handleRegister(e));
    modal
      .querySelector<HTMLFormElement>("#unlock-form")!
      .addEventListener("submit", (e) => this.handleUnlock(e));

    modal
      .querySelector<HTMLElement>("#sync-now-btn")!
      .addEventListener("click", () => {
        void this.sync(true);
      });

    modal
      .querySelector<HTMLElement>("#logout-btn")!
      .addEventListener("click", () => this.logout());

    const deleteBtn = modal.querySelector<HTMLElement>("#delete-account-btn")!;
    deleteBtn.addEventListener("click", () => {
      void this.deleteAccount();
    });

    document.addEventListener("click", (e) => {
      const overlay = document.getElementById("overlay");
      if (overlay && e.target === overlay && isManagedModalOpen(modal)) {
        this.toggleCloudSyncModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isManagedModalOpen(modal)) {
        this.toggleCloudSyncModal();
      }
    });

    const toggles = modal.querySelectorAll<HTMLElement>(".password-toggle");
    toggles.forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const targetId = toggle.getAttribute("data-target");
        const input = document.getElementById(
          targetId!,
        ) as HTMLInputElement | null;
        if (!input) return;

        if (input.type === "password") {
          input.type = "text";
          toggle.innerHTML = svgIcon("IconEyeSlash");
        } else {
          input.type = "password";
          toggle.innerHTML = svgIcon("IconEyeOpen");
        }
      });
    });
  }

  async toggleCloudSyncModal(): Promise<void> {
    if (isStatic) return;
    if (!document.getElementById("cloudsync-modal")) {
      await this.createCloudSyncModal();
    }

    const modal = document.getElementById("cloudsync-modal") as HTMLElement;
    if (isManagedModalOpen(modal)) {
      closeManagedModal(modal);
    } else {
      this.updateModalState();
      openManagedModal(modal);
    }
  }

  updateModalState(): void {
    const loggedInView = document.getElementById("auth-logged-in");
    const formsView = document.getElementById("auth-forms");
    const userDisplay = document.getElementById("auth-user-display");
    const authTitle = document.getElementById("auth-title");
    const encryptionStatus = document.getElementById("sync-encryption-status");
    const unlockForm = document.getElementById("unlock-form");
    const unlockButton = document.getElementById("unlock-btn");

    if (this.isAuthenticated) {
      if (loggedInView) loggedInView.style.display = "block";
      if (formsView) formsView.style.display = "none";
      if (userDisplay) userDisplay.textContent = this.user.username ?? "";
      if (authTitle) authTitle.textContent = "cloud sync";
    } else {
      if (loggedInView) loggedInView.style.display = "none";
      if (formsView) formsView.style.display = "block";
      if (authTitle) authTitle.textContent = "login";
    }

    const encryptable = canEncryptSync();
    const needsKey = this.isAuthenticated && encryptable && !this.keys;
    if (encryptionStatus) {
      encryptionStatus.textContent = !this.isAuthenticated || !encryptable
        ? ""
        : this.keys
          ? `end-to-end encrypted${this.lastSyncedText()}`
          : this.locked
            ? "enter your password to unlock sync"
            : `enter your password to encrypt sync end-to-end${this.lastSyncedText()}`;
    }
    if (unlockForm) unlockForm.style.display = needsKey ? "block" : "none";
    if (unlockButton) {
      unlockButton.textContent = this.locked ? "unlock sync" : "encrypt sync";
    }

    const statusEl = document.querySelector<HTMLElement>("#auth-status");
    if (statusEl)
      statusEl.textContent = this.isAuthenticated
        ? (this.user.username ?? "")
        : "cloud sync";
  }

  lastSyncedText(): string {
    const revision = this.syncMeta.last_synced;
    const time = revision ? revisionTime(revision) : Number.NaN;
    if (!Number.isFinite(time)) return "";
    const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
    if (minutes < 1) return "; last synced just now";
    if (minutes < 60) return `; last synced ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `; last synced ${hours}h ago`;
    return `; last synced ${Math.round(hours / 24)}d ago`;
  }

  updateStatus(text: string, cls?: string): void {
    this._statusText = text;
    const ind = document.getElementById("sync-status-indicator");

    const updateEl = (el: HTMLElement | null): void => {
      if (!el) return;
      if (this._lastStatusText === text && this._lastStatusType === cls) return;
      this._lastStatusText = text;
      this._lastStatusType = cls;

      el.textContent = text;
    };

    updateEl(ind);
    if (cls === "success") this.updateModalState();
  }

  rejectInsecureContext(): boolean {
    if (canEncryptSync()) return false;
    if (window.showToast)
      window.showToast("error", SECURE_CONNECTION_TEXT, "IconExclamationTriangle");
    else this.showError(SECURE_CONNECTION_TEXT);
    return true;
  }

  async handleLogin(e: Event): Promise<void> {
    e.preventDefault();
    if (this.rejectInsecureContext()) return;
    const username = (
      document.getElementById("login-username") as HTMLInputElement
    ).value;
    const password = (
      document.getElementById("login-password") as HTMLInputElement
    ).value;
    (document.getElementById("login-password") as HTMLInputElement).value = "";

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "logging in...",
        "IconArrowRotateClockwise",
        0,
      );

    try {
      const { session, master } = await signIn(username, password);
      try {
        this.setSession(session as unknown as SessionData);
        await this.adoptKeys(master);
      } finally {
        master.fill(0);
      }
      if (toastController) toastController.hide();
      this.toggleCloudSyncModal();
      await this.restoreData(false, true);
    } catch (error) {
      if (toastController) toastController.hide();
      const failure = authFailure(error);
      const message =
        failure === "invalid_credentials"
          ? "login failed... /ᐠ - ˕ -マ"
          : failure === "too_many_attempts"
            ? TOO_MANY_ATTEMPTS_TEXT
            : "connection error... /ᐠ - ˕ -マ";
      if (window.showToast)
        window.showToast("error", message, "IconExclamationTriangle");
      else this.showError(message);
      if (failure === "unavailable" && !this.isAuthenticated) {
        await this.checkAuthStatus();
      }
      if (failure !== "invalid_credentials" && failure !== "too_many_attempts") {
        console.error("login failed... /ᐠ - ˕ -マ");
      }
    }
  }

  async fetchUsernameAvailability(
    username: string,
    signal: AbortSignal,
  ): Promise<boolean | null> {
    try {
      const response = await fetch(
        `/api/auth/username?name=${encodeURIComponent(username)}`,
        { credentials: "same-origin", signal },
      );
      if (!response.ok) return null;
      const payload = (await response.json().catch(() => null)) as {
        available?: unknown;
      } | null;
      if (typeof payload?.available !== "boolean") return null;
      if (this.usernameAvailability.size >= 50) this.usernameAvailability.clear();
      this.usernameAvailability.set(username, payload.available);
      return payload.available;
    } catch {
      return null;
    }
  }

  async handleRegister(e: Event): Promise<void> {
    e.preventDefault();
    if (this.rejectInsecureContext()) return;
    const usernameInput = document.getElementById(
      "reg-username",
    ) as HTMLInputElement;
    const passwordInput = document.getElementById(
      "reg-password",
    ) as HTMLInputElement;
    const usernameFeedback = document.getElementById("reg-username-feedback");
    const passwordFeedback = document.getElementById("reg-password-feedback");
    const username = usernameInput.value;
    const password = passwordInput.value;

    const usernameError = usernameSubmitError(username);
    if (usernameError) {
      if (usernameFeedback) setFieldHint(usernameFeedback, "error", usernameError);
      usernameInput.focus();
      return;
    }
    if (this.usernameAvailability.get(username) === false) {
      if (usernameFeedback) {
        setFieldHint(usernameFeedback, "error", USERNAME_TAKEN_TEXT);
      }
      usernameInput.focus();
      return;
    }
    const passwordError = passwordSubmitError(password);
    if (passwordError) {
      if (passwordFeedback) setFieldHint(passwordFeedback, "error", passwordError);
      passwordInput.focus();
      return;
    }

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "creating account...",
        "IconArrowRotateClockwise",
        0,
      );

    try {
      const { session, master } = await createAccount(username, password);
      passwordInput.value = "";
      try {
        this.setSession(session as unknown as SessionData);
        await this.adoptKeys(master);
      } finally {
        master.fill(0);
      }
      if (toastController) toastController.hide();
      this.toggleCloudSyncModal();
      this.syncMeta = { dirty: true, last_synced: null };
      this.saveMeta();
      await this.syncData(true);
    } catch (error) {
      if (toastController) toastController.hide();
      const failure = authFailure(error);
      if (failure === "username_taken") {
        this.usernameAvailability.set(username, false);
        if (usernameFeedback) {
          setFieldHint(usernameFeedback, "error", USERNAME_TAKEN_TEXT);
        }
        usernameInput.focus();
        return;
      }
      const message =
        failure === "too_many_attempts"
          ? TOO_MANY_ATTEMPTS_TEXT
          : failure === "invalid_credentials"
            ? "account creation failed... /ᐠ - ˕ -マ"
            : "connection error... /ᐠ - ˕ -マ";
      if (window.showToast)
        window.showToast("error", message, "IconExclamationTriangle");
      else this.showError(message);
      if (failure === "unavailable" && !this.isAuthenticated) {
        await this.checkAuthStatus();
      }
      if (failure !== "too_many_attempts" && failure !== "invalid_credentials") {
        console.error("account creation failed... /ᐠ - ˕ -マ");
      }
    }
  }

  async handleUnlock(e: Event): Promise<void> {
    e.preventDefault();
    if (this.rejectInsecureContext()) return;
    const input = document.getElementById(
      "unlock-password",
    ) as HTMLInputElement | null;
    const password = input?.value ?? "";
    if (input) input.value = "";
    if (!password || !this.user.username) return;

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "securing sync...",
        "IconArrowRotateClockwise",
        0,
      );
    try {
      const { session, master } = await signIn(this.user.username, password);
      try {
        this.setSession(session as unknown as SessionData);
        await this.adoptKeys(master);
      } finally {
        master.fill(0);
      }
      if (!this.keys) throw new Error(negativeMessage("unlock failed"));
      toastController?.hide();
      this._lockNotified = false;
      this.setLocked(false);
      if (window.showToast)
        window.showToast("success", "sync is end-to-end encrypted!! (˵◝ ⩊  ◜˵マ", "IconCircleInfo");
      this.syncMeta.dirty = true;
      this.saveMeta();
      await this.sync(true);
    } catch (error) {
      toastController?.hide();
      const message =
        authFailure(error) === "too_many_attempts"
          ? TOO_MANY_ATTEMPTS_TEXT
          : "unlock failed... /ᐠ - ˕ -マ";
      if (window.showToast)
        window.showToast("error", message, "IconExclamationTriangle");
      else this.showError(message);
    }
  }

  setSession(session: SessionData): void {
    this.isAuthenticated = true;
    this.user = session.user;
    localStorage.setItem("auth_user", JSON.stringify(this.user));
    this.updateModalState();
    this.startPolling();
    document.dispatchEvent(new CustomEvent("cloudsync-session"));
  }

  async logout(): Promise<void> {
    if (window.showToast) {
      window.showToast("info", "confirm logout?", "IconCircleInfo", [
        {
          text: "cancel",
          dismiss: true,
        },
        {
          text: "logout",
          class: "danger-btn",
          dismiss: true,
          callback: async () => {
            await this.performLogout();
          },
        },
      ]);
    } else {
      if (!confirm("confirm logout?")) return;
      void this.performLogout();
    }
  }

  async performLogout(): Promise<void> {
    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "logging out...",
        "IconCircleInfo",
        0,
      );

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      console.warn("logout failed... /ᐠ - ˕ -マ");
    }

    if (toastController) toastController.hide();

    this.stopPolling();
    this.isAuthenticated = false;
    this.user = {};
    this.keys = null;
    localStorage.removeItem("auth_user");
    localStorage.removeItem(SYNC_META_KEY);

    await this.wipeLocalData();

    window.bypassPreventClosing = true;
    window.location.reload();
  }

  async deleteAccount(): Promise<void> {
    if (!this.isAuthenticated) return;

    if (window.showToast) {
      window.showToast(
        "info",
        "confirm deletion?",
        "IconExclamationTriangle",
        [
          {
            text: "cancel",
            dismiss: true,
          },
          {
            text: "delete",
            class: "danger-btn",
            dismiss: true,
            callback: async () => {
              await this.performDelete();
            },
          },
        ],
      );
    } else {
      if (
        confirm(
          "are you sure? this will delete your account and all synced data permanently... /ᐠ - ˕ -マ",
        )
      ) {
        void this.performDelete();
      }
    }
  }

  async performDelete(): Promise<void> {
    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "deleting account...",
        "IconExclamationTriangle",
        0,
      );

    try {
      const response = await fetch("/api/auth/me", {
        method: "DELETE",
        credentials: "same-origin",
      });

      if (response.ok) {
        if (toastController) toastController.hide();
        this.stopPolling();
        this.isAuthenticated = false;
        this.user = {};
        this.keys = null;
        localStorage.removeItem("auth_user");
        localStorage.removeItem(SYNC_META_KEY);

        await this.wipeLocalData();

        window.bypassPreventClosing = true;
        window.location.reload();
      } else {
        if (toastController) toastController.hide();
        if (window.showToast)
          window.showToast(
            "error",
            "account deletion failed... /ᐠ - ˕ -マ",
            "IconExclamationTriangle",
          );
        else alert("account deletion failed... /ᐠ - ˕ -マ");
      }
    } catch {
      if (toastController) toastController.hide();
      if (window.showToast)
        window.showToast(
          "error",
          "account deletion failed... /ᐠ - ˕ -マ",
          "IconExclamationTriangle",
        );
      else alert("account deletion failed... /ᐠ - ˕ -マ");
      console.error("account deletion failed... /ᐠ - ˕ -マ");
    }
  }

  showError(message: string): void {
    const errorElement = document.getElementById("auth-error");
    if (errorElement) {
      errorElement.textContent = message;
      setTimeout(() => (errorElement.textContent = ""), 3000);
    }
  }

  async wipeLocalData(): Promise<void> {
    try {
      const preserveKeys = ["alertClosed", "lyraVisited", "lyraVersion"];

      const preservedData: Record<string, string> = {};
      preserveKeys.forEach((key) => {
        const value = localStorage.getItem(key);
        if (value !== null) preservedData[key] = value;
      });

      localStorage.clear();
      sessionStorage.clear();

      localStorage.removeItem("lyra-bookmarks");

      Object.keys(preservedData).forEach((key) => {
        localStorage.setItem(key, preservedData[key]!);
      });
    } catch {
      console.error("[cloudsync] storage wipe failed... /ᐠ - ˕ -マ");
    }

    try {
      document.cookie.split(";").forEach((c) => {
        document.cookie = c
          .replace(/^ +/, "")
          .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });
    } catch {
      console.warn("cookie clear failed... /ᐠ - ˕ -マ");
    }

    if ("indexedDB" in window) {
      try {
        indexedDB.deleteDatabase(SYNC_LOCAL_DATABASE);
        if (typeof indexedDB.databases === "function") {
          const dbs = await indexedDB.databases();
          for (const dbInfo of dbs) {
            if (dbInfo.name) {
              indexedDB.deleteDatabase(dbInfo.name!);
            }
          }
        }
      } catch {
        console.warn("[cloudsync] indexeddb wipe failed... /ᐠ - ˕ -マ");
      }
    }

    if ("serviceWorker" in navigator) {
      try {
        const registrations = await appServiceWorkers();
        await Promise.all(registrations.map((r) => r.unregister()));
      } catch {
        console.warn("[cloudsync] service worker cleanup failed... /ᐠ - ˕ -マ");
      }
    }

    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        console.warn("[cloudsync] cache cleanup failed... /ᐠ - ˕ -マ");
      }
    }
  }
}

function initCloudSync(): void {
  void new CloudSync();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCloudSync, {
    once: true,
  });
} else {
  initCloudSync();
}
