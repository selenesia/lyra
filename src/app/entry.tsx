import { render } from "preact";
import App from "./App.tsx";
import { store } from "../state/store.ts";
import { handleServiceWorkerMessage } from "../state/serviceWorkerMessages.ts";
import { initSplitResize } from "../state/splitResize.ts";
import { setupWindowLyra } from "../state/windowLyra.ts";
import { initUiSignals } from "../core/ui/uiSignals";
import { scheduleIdleTask } from "../core/runtime/scheduler.ts";
import { initCloaking } from "../features/cloaking.ts";
import "../features/cloudsync/syncBoundary.ts";
import { resolveTheme } from "../core/config/settingsOptions.ts";
import { applyTheme } from "../core/ui/theme.ts";
import {
  applyMotionPreference,
  readAdvancedToggle,
  readMotionPreference,
} from "../core/config/advancedSettings.ts";
import { loadCloudSync } from "./loaders.ts";
import { warmProxyRuntime } from "../core/proxy/proxyRuntime.ts";
import { fetchServiceMetadata } from "../core/runtime/serviceMetadata.ts";
import { isStatic } from "../core/runtime/hosting.ts";
import "../assets/styles/base/themes.css";
import "../assets/styles/base/motion.css";
import "../assets/styles/base/index.css";
import "../assets/styles/browser/tabs.css";
import "../assets/styles/browser/rivet.css";

const recoveryUrl = new URL(window.location.href);
if (recoveryUrl.searchParams.has("recovery")) {
  recoveryUrl.searchParams.delete("recovery");
  history.replaceState(history.state, "", recoveryUrl.href);
}

applyTheme(resolveTheme(localStorage.getItem("theme")));

applyMotionPreference(readMotionPreference());

void fetchServiceMetadata();

let cloudSyncLoadPromise: Promise<void> | null = null;
let cloudSyncReady = false;

function ensureCloudSyncLoaded() {
  if (cloudSyncReady) return Promise.resolve();
  if (cloudSyncLoadPromise) return cloudSyncLoadPromise;

  cloudSyncLoadPromise = loadCloudSync()
    .then(() => {
      cloudSyncReady = true;
    })
    .catch((error) => {
      cloudSyncLoadPromise = null;
      throw error;
    });

  return cloudSyncLoadPromise;
}

function shouldPreloadCloudSync() {
  try {
    const raw = localStorage.getItem("auth_user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    return typeof user?.username === "string" && user.username.length > 0;
  } catch {
    return false;
  }
}

function initializeLyraApp() {
  const runtimeWindow = window as typeof window & {
    __lyraAppInitialized?: boolean;
  };
  const appRoot = document.querySelector<HTMLElement>(".meow");
  if (
    !appRoot ||
    runtimeWindow.__lyraAppInitialized ||
    appRoot.dataset.lyraAppInitialized === "true"
  ) {
    return;
  }
  runtimeWindow.__lyraAppInitialized = true;
  appRoot.dataset.lyraAppInitialized = "true";

  initUiSignals();
  initCloaking();
  setupWindowLyra();

  if (!isStatic) document.addEventListener(
    "toggleCloudSyncModal",
    (event: Event) => {
      if (cloudSyncReady) return;

      event.stopImmediatePropagation();
      void ensureCloudSyncLoaded()
        .then(() => {
          document.dispatchEvent(new CustomEvent("toggleCloudSyncModal"));
        })
        .catch((error) => {
          console.error(
            "failed to load cloud sync module:",
            error,
            "... /ᐠ - ˕ -マ",
          );
        });
    },
    true,
  );

  render(<App />, appRoot);

  requestAnimationFrame(() => {
    void import("../assets/styles/toast/toast.css");
    void import("../features/ui/toast.ts");
  });

  scheduleIdleTask(() => {
    void import("../core/runtime/load.ts").then((module) => {
      module.initializeLoad();
    });
  }, 1000);

  if (!isStatic) scheduleIdleTask(() => {
    if (!shouldPreloadCloudSync()) return;
    void ensureCloudSyncLoaded();
  }, 1500);

  scheduleIdleTask(() => {
    if (readAdvancedToggle("preloadProxy")) warmProxyRuntime();
  }, 750);

  const onSwMessage = (e: MessageEvent) => handleServiceWorkerMessage(e);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
  window.addEventListener("message", onSwMessage);

  initSplitResize();

  store.addTab(null, "fetching data...", false, null, {
    applyNewTabOverride: false,
  });
  store.updateIframeView();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeLyraApp, {
    once: true,
  });
} else {
  initializeLyraApp();
}
