import { attachSearchLight } from "../ui/searchLight.ts";
import { scheduleIdleTask } from "./scheduler.ts";
import { svgIcon } from "../ui/svgIcon.ts";
import { negativeMessage, positiveMessage } from "./messages.ts";
import { fetchServiceMetadata } from "./serviceMetadata.ts";
import { appPath, appServiceWorkers, isStatic } from "./hosting.ts";
import {
  addUpdateMarker,
  clientBuildId,
  decideUpdate,
  parseStuffResponse,
  parseUpdateAttempt,
  readUpdateMarker,
  removeUpdateMarker,
  UPDATE_CHECK_THROTTLE_MS,
  UPDATE_POLL_MS,
  type UpdateAttempt,
} from "./updater.ts";

declare global {
  interface Window {
    lyraUpdater: {
      successEl: HTMLElement | null;
      overlay: HTMLElement | null;
      closeBtn: HTMLElement | null;
      init(): void;
      showSuccess(): void;
      hideSuccess(calledByOther: boolean): void;
      performUpdate(target: string, attempt: UpdateAttempt): Promise<void>;
      checkVersion(force?: boolean): Promise<void>;
      updating: boolean;
    };
    hideBookmarkModal?: (calledByOther: boolean) => void;
    __lyraUpdatePollerStarted?: boolean;
  }
}

let _loadInitialized = false;
let _initialStuffDataUsed = false;
let versionCheckRunning = false;
let lastVersionCheckAt = 0;

const UPDATE_TARGET_KEY = "lyraUpdateTarget";
const UPDATE_ATTEMPT_KEY = "lyraUpdateAttempt";

type StorageName = "localStorage" | "sessionStorage";

function readStorage(storage: StorageName, key: string): string | null {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(
  storage: StorageName,
  key: string,
  value: string | null,
): void {
  try {
    if (value === null) window[storage].removeItem(key);
    else window[storage].setItem(key, value);
  } catch {}
}

function clearUpdateState(): void {
  writeStorage("localStorage", UPDATE_TARGET_KEY, null);
  writeStorage("sessionStorage", UPDATE_ATTEMPT_KEY, null);
  writeStorage("localStorage", "lyraUpdateAttempt", null);
  writeStorage("localStorage", "lyraVersionStamp", null);
  writeStorage("localStorage", "justUpdated", null);
  writeStorage("sessionStorage", "lyraUpdateAttemptAt", null);
}

function clearUpdateMarker(): void {
  const cleanHref = removeUpdateMarker(window.location.href);
  if (cleanHref !== window.location.href) {
    history.replaceState(history.state, "", cleanHref);
  }
}

export function initializeLoad(): void {
  if (_loadInitialized) return;
  _loadInitialized = true;

  {
    const search = window.location.search;
    if (search.startsWith("?=") && [appPath("/s"), ...(isStatic ? [appPath("/index.html")] : [])].includes(window.location.pathname)) {
      let url = search.slice(2);
      try {
        url = decodeURIComponent(url);
      } catch {}
      history.replaceState(null, "", isStatic ? appPath("/index.html") : "/");
      setTimeout(() => {
        (window as any).Lyra?.handleSearch(url);
      }, 100);
    }
  }

  scheduleIdleTask(() => {
    import("../../features/games/games.ts")
      .then(async ({ fetchGameData, getGameDisplayLabel }) => {
        ((window as any).Lyra ??= {}).getGameDisplayLabel = getGameDisplayLabel;
        try {
          await fetchGameData();
        } catch {}
        const tab = (window as any).Lyra?.getActiveTab?.();
        if (tab?.iframe) {
          const { updateHistoryUI } = await import("../browser/historyUI.ts");
          const { decodeUrl } = await import("./utils.ts");
          const decoded = decodeUrl(
            tab.iframe.dataset.manualUrl || tab.iframe.src,
          );
          updateHistoryUI(tab as any, {
            currentUrl: decoded,
            canGoBack: tab.historyManager?.canGoBack?.() ?? false,
            canGoForward: tab.historyManager?.canGoForward?.() ?? false,
          });
        }
      })
      .catch(() => {});
  }, 2000);

  document
    .querySelectorAll<HTMLElement>(".search-bar")
    .forEach(attachSearchLight);

  window.lyraUpdater = {
    successEl: null,
    overlay: document.getElementById("overlay"),
    closeBtn: null,
    updating: false,
    init() {
      this.successEl = document.getElementById("updateSuccess");
      if (!this.successEl) {
        this.successEl = document.createElement("div");
        this.successEl.id = "updateSuccess";
        document.body.appendChild(this.successEl);
        this.successEl.innerHTML = `
            ${svgIcon("IconCheckCircle2", { size: 44, style: "margin-bottom:15px" })}
            <label>${positiveMessage("update applied")}</label>
            <p>the correct build is now running!</p>
            <button class="prompt-close-btn" id="updateSuccessClose">okay!!</button>
          `;
      }
      this.closeBtn = document.getElementById("updateSuccessClose");

      this.closeBtn?.addEventListener("click", () => this.hideSuccess(false));

      document.addEventListener("keydown", (e: KeyboardEvent) => {
        if (
          e.key === "Escape" &&
          this.successEl &&
          this.successEl.style.display === "block" &&
          !this.successEl.classList.contains("fade-out")
        ) {
          this.hideSuccess(false);
        }
      });
    },
    showSuccess() {
      this.overlay = document.getElementById("overlay");
      if (!this.successEl || !this.overlay) return;

      if (!this.overlay.dataset["lyraUpdateOverlayBound"]) {
        this.overlay.addEventListener("click", (e: MouseEvent) => {
          const activeOverlay = document.getElementById("overlay");
          if (!activeOverlay || e.target !== activeOverlay) return;
          if (
            document.getElementById("updateSuccess")?.style.display === "block"
          ) {
            window.lyraUpdater.hideSuccess(false);
          }
        });
        this.overlay.dataset["lyraUpdateOverlayBound"] = "true";
      }

      if (
        window.hideBookmarkModal &&
        (document
          .getElementById("bookmark-modal")
          ?.classList.contains("modal-visible") ||
          document
            .getElementById("bookmark-modal")
            ?.classList.contains("modal-closing"))
      ) {
        window.hideBookmarkModal(true);
      }

      this.overlay.classList.add("show");
      this.successEl.style.display = "block";
      this.successEl.classList.remove("fade-out");
    },
    hideSuccess(calledByOther: boolean) {
      if (!this.successEl || this.successEl.style.display === "none") return;

      this.successEl.classList.add("fade-out");
      this.successEl.addEventListener(
        "animationend",
        () => {
          this.successEl!.style.display = "none";
          this.successEl!.classList.remove("fade-out");

          if (calledByOther) return;

          this.overlay?.classList.remove("show");
        },
        { once: true },
      );
    },
    async performUpdate(target, attempt) {
      if (this.updating) return;
      this.updating = true;
      writeStorage("localStorage", UPDATE_TARGET_KEY, target);
      writeStorage("sessionStorage", UPDATE_ATTEMPT_KEY, JSON.stringify(attempt));

      try {
        if ("serviceWorker" in navigator) {
          const results = await Promise.all(
            (await appServiceWorkers()).map((e) =>
              e.unregister(),
            ),
          );
          if (results.some((removed) => !removed)) {
            console.warn(
              negativeMessage(
                "automatic update could not unregister every service worker",
              ),
            );
          }
        }
      } catch (error) {
        console.error(
          negativeMessage("automatic update service-worker cleanup failed"),
          error,
        );
      }

      try {
        if ("caches" in window) {
          const results = await Promise.all(
            (await caches.keys()).map((key) => caches.delete(key)),
          );
          if (results.some((removed) => !removed)) {
            console.warn(
              negativeMessage("automatic update could not clear every cache"),
            );
          }
        }
      } catch (error) {
        console.error(
          negativeMessage("automatic update cache cleanup failed"),
          error,
        );
      }

      try {
        location.replace(addUpdateMarker(location.href, target));
      } catch (error) {
        this.updating = false;
        throw error;
      }
      window.setTimeout(() => {
        this.updating = false;
      }, 10_000);
    },
    async checkVersion(force = false) {
      if (versionCheckRunning || this.updating) return;
      const now = Date.now();
      if (!force && now - lastVersionCheckAt < UPDATE_CHECK_THROTTLE_MS) return;
      versionCheckRunning = true;
      lastVersionCheckAt = now;
      try {
        const initialStuffData = !_initialStuffDataUsed
          ? window.__lyraStuffData
          : null;
        _initialStuffDataUsed = true;
        let serviceMetadata = await (
          initialStuffData || fetchServiceMetadata(true)
        );
        if (!serviceMetadata && initialStuffData) {
          serviceMetadata = await fetchServiceMetadata(true);
        }
        if (!serviceMetadata) return;
        const metadata = parseStuffResponse(serviceMetadata);
        writeStorage("localStorage", "lyraVersion", metadata.version);

        const marker = readUpdateMarker(location.href);
        const decision = decideUpdate(metadata, clientBuildId, {
          pending: readStorage("localStorage", UPDATE_TARGET_KEY),
          attempt: parseUpdateAttempt(
            readStorage("sessionStorage", UPDATE_ATTEMPT_KEY),
          ),
          marker,
        });
        if (marker !== null) clearUpdateMarker();

        if (decision.action === "reload") {
          await this.performUpdate(decision.target, decision.attempt);
          return;
        }
        if (decision.action === "wait") {
          if (decision.failed) {
            console.warn(
              negativeMessage(
                "automatic update could not load the current build",
              ),
            );
          }
          return;
        }

        clearUpdateState();
        if (decision.applied) this.showSuccess();
      } catch (error) {
        console.warn(negativeMessage("version check failed"), error);
      } finally {
        versionCheckRunning = false;
      }
    },
  };
  window.lyraUpdater.init();
  void window.lyraUpdater.checkVersion(true);
  if (!window.__lyraUpdatePollerStarted) {
    window.__lyraUpdatePollerStarted = true;
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void window.lyraUpdater.checkVersion();
      }
    };
    window.setInterval(checkWhenVisible, UPDATE_POLL_MS);
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("online", checkWhenVisible);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) void window.lyraUpdater.checkVersion(true);
    });
    window.addEventListener("vite:preloadError", () => {
      void window.lyraUpdater.checkVersion(true);
    });
  }
}
