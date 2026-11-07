import {
  uploadSnapshot,
  uploadSealedSnapshot,
  downloadSnapshot,
} from "./syncTransfer.ts";
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
import { negativeMessage } from "../../core/runtime/messages.ts";
import { isStatic } from "../../core/runtime/hosting.ts";
import type { ToastController } from "../../core/ui/toast.ts";
import {
  applySyncDelta,
  changedDuringUpload,
} from "./syncSnapshot.ts";
import type { SyncSnapshot } from "./snapshotSchema.ts";
import { type SyncMeta, SYNC_META_KEY, revisionTime } from "./syncMeta.ts";
import * as modalMethods from "./cloudSyncModal.ts";
import * as accountMethods from "./cloudSyncAccount.ts";
import * as storageHookMethods from "./cloudSyncHooks.ts";

interface SyncBase {
  revision: string;
  index: SnapshotIndex;
}

export interface AuthUser {
  username?: string;
  id?: string | number;
  sync_salt?: string;
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
const SCAN_COST_FACTOR = 40;
const SCAN_MAX_INTERVAL = 5 * 60_000;
const FOLLOW_UP_THRESHOLD = 1000;
const FOLLOW_UP_MAX = 30_000;
const SYNC_LOCK = "lyra-cloudsync";
const LOCKED_STATUS = "sync is locked; enter your password... /ᐠ - ˕ -マ";

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

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
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
  declare showLoadingScreen: typeof modalMethods.showLoadingScreen;
  declare hideLoadingScreen: typeof modalMethods.hideLoadingScreen;
  declare createCloudSyncModal: typeof modalMethods.createCloudSyncModal;
  declare attachCloudSyncModalListeners: typeof modalMethods.attachCloudSyncModalListeners;
  declare toggleCloudSyncModal: typeof modalMethods.toggleCloudSyncModal;
  declare updateModalState: typeof modalMethods.updateModalState;
  declare lastSyncedText: typeof modalMethods.lastSyncedText;
  declare updateStatus: typeof modalMethods.updateStatus;
  declare showError: typeof modalMethods.showError;
  declare rejectInsecureContext: typeof accountMethods.rejectInsecureContext;
  declare handleLogin: typeof accountMethods.handleLogin;
  declare fetchUsernameAvailability: typeof accountMethods.fetchUsernameAvailability;
  declare handleRegister: typeof accountMethods.handleRegister;
  declare handleUnlock: typeof accountMethods.handleUnlock;
  declare setSession: typeof accountMethods.setSession;
  declare logout: typeof accountMethods.logout;
  declare performLogout: typeof accountMethods.performLogout;
  declare deleteAccount: typeof accountMethods.deleteAccount;
  declare performDelete: typeof accountMethods.performDelete;
  declare wipeLocalData: typeof accountMethods.wipeLocalData;
  declare hookStorage: typeof storageHookMethods.hookStorage;
  declare hookLifecycle: typeof storageHookMethods.hookLifecycle;
  declare scheduleSync: typeof storageHookMethods.scheduleSync;
  declare markDirty: typeof storageHookMethods.markDirty;

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
}

Object.assign(
  CloudSync.prototype,
  modalMethods,
  accountMethods,
  storageHookMethods,
);

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
