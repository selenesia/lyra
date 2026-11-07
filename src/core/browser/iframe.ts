import { showLoading, hideLoading } from "../../state/store.ts";
import {
  decodeUrl,
  getProxyUrl,
} from "../runtime/utils";
import {
  getLoadedGameCover,
} from "../media/gameMetadata.ts";
import { getRivet } from "../proxy/rivetBridge.ts";
import { folioPageStateDocuments } from "../proxy/folioPageState.ts";
import { NEGATIVE } from "../runtime/messages.ts";
import { appPath } from "../runtime/hosting.ts";
import type { HistoryManager } from "./history.ts";
import {
  isCurrentNavigation,
  beginNavigation,
  navigationVersions,
} from "./navigationVersion.ts";
import {
  clearGameLoadState,
  armGameLoadTimeout,
  syncGlobalLoadingState,
  failGameNavigation,
  isKnownGameErrorDocument,
  finishGameLoadMetric,
} from "./gameLoad.ts";
import {
  getBestKnownUrl,
  getTabIdFromIframe,
  pageStateUrl,
  navigationUrl,
} from "./iframeUrls.ts";
import { updateHistoryUI } from "./historyUI.ts";
import {
  shouldRouteThroughFolio,
  navigateExternalThroughFolio,
  waitForNavigationTransport,
} from "./folioNavigation.ts";

export interface LyraTab {
  id: number;
  iframe: HTMLIFrameElement;
  title: string;
  favicon: string | null;
  isUrlLoaded: boolean;
  isLoading: boolean;
  isGame?: boolean;
  fixedTitle?: boolean;
  fixedFavicon?: boolean;
  gameDisplayByUrl?: Record<string, string>;
  extensionPage?: {
    extId: string;
    page: string;
    url: string;
  };
  pageState?: {
    url: string | null;
    title: string;
    favicon: string | null;
    historyLength: number | null;
    historyState: unknown;
    navigationType: string | null;
    updatedAt: number;
  };
  historyManager?: HistoryManager;
  [key: string]: unknown;
}

type IframeHistoryManager = NonNullable<LyraTab["historyManager"]>;
type IframeInternalHandlers = {
  onError: EventListener;
  onLoad: EventListener;
  version: number;
};

declare global {
  interface Window {
    Lyra: {
      tabs?: LyraTab[];
      isLoading?: boolean;
      setPlayerStatus?: (tabId: number, status: string) => void;
      navigateFolio?: (iframe: HTMLIFrameElement, url: string) => Promise<void>;
      releaseFolioFrame?: (iframe: HTMLIFrameElement) => void;
      waitForTransport?: (timeout: number) => Promise<void>;
      [key: string]: unknown;
    };
  }
}

type ContentWindowListeners = {
  historyCleanup?: () => void;
  beforeUnload?: EventListener;
  domContentLoaded?: EventListener;
  focus?: EventListener;
};

const contentWindowListeners = new WeakMap<Window, ContentWindowListeners>();

export function historyEntry(iframe: HTMLIFrameElement) {
  try {
    return iframe.contentWindow?.navigation?.currentEntry ?? null;
  } catch {
    return null;
  }
}

export function navigateHistory(
  iframe: HTMLIFrameElement,
  delta: -1 | 1,
): void {
  const tab = window.Lyra.tabs?.find(
    (candidate) => candidate.iframe === iframe,
  );
  const history = tab?.historyManager;
  const target = history?.getTarget(delta);
  if (!history || !target) return;
  try {
    const navigation = iframe.contentWindow?.navigation;
    if (
      target.key &&
      navigation?.entries().some((entry) => entry.key === target.key)
    ) {
      clearGameLoadState(iframe, true);
      const result = navigation.traverseTo(target.key);
      void result.committed?.catch(() => {});
      void result.finished?.catch(() => {});
      return;
    }
  } catch {}
  if (delta === -1) history.back();
  else history.forward();
  navigateIframeTo(iframe, target.url, "replace");
}

export function reloadIframe(iframe: HTMLIFrameElement): void {
  const tab = window.Lyra.tabs?.find(
    (candidate) => candidate.iframe === iframe,
  );
  const url = getBestKnownUrl(iframe, tab);
  if (!tab?.historyManager || !url) return;
  const version = beginNavigation(iframe);
  iframe.dataset.navigationVersion = String(version);
  tab.historyManager.begin("replace");
  installIframeLoadHandlers(iframe, tab.historyManager, tab.id, version);
  clearGameLoadState(iframe, true);
  armGameLoadTimeout(iframe, version, tab.id);
  showLoading(tab.id);
  iframe.parentElement?.classList.remove("loaded");
  try {
    iframe.contentWindow!.location.reload();
  } catch {
    navigateIframeTo(iframe, url, "replace");
  }
}

function applyPageStateToTab(tab: LyraTab): boolean {
  const pageState = tab.pageState;
  if (!pageState) return false;
  let applied = false;
  if (
    !tab.fixedTitle &&
    typeof pageState.title === "string" &&
    pageState.title.trim()
  ) {
    tab.title = pageState.title.trim();
    applied = true;
  }
  if (!tab.fixedFavicon && pageState.favicon) {
    tab.favicon = pageState.favicon;
    applied = true;
  }
  return applied;
}

function detachContentWindowListeners(iframe: HTMLIFrameElement): void {
  try {
    const iframeWindow = iframe.contentWindow;
    if (!iframeWindow) return;
    const listeners = contentWindowListeners.get(iframeWindow);
    if (!listeners) return;
    contentWindowListeners.delete(iframeWindow);
    listeners.historyCleanup?.();
    if (listeners.beforeUnload) {
      iframeWindow.removeEventListener("beforeunload", listeners.beforeUnload);
    }
    if (listeners.domContentLoaded) {
      iframeWindow.removeEventListener(
        "DOMContentLoaded",
        listeners.domContentLoaded,
      );
    }
    if (listeners.focus) {
      iframeWindow.removeEventListener("mousedown", listeners.focus, true);
    }
  } catch (e) {
    console.warn("unable to detach iframe window listeners:", e, NEGATIVE);
  }
}

export function stopIframeLoading(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  const version = beginNavigation(iframe);
  const tabId = getTabIdFromIframe(iframe);
  const currentTab = window.Lyra.tabs?.find((tab) => tab.id === tabId);
  if (currentTab?.historyManager) {
    installIframeLoadHandlers(
      iframe,
      currentTab.historyManager,
      tabId,
      version,
    );
  }
  clearGameLoadState(iframe, true);

  try {
    if (iframe.contentWindow) iframe.contentWindow.stop();
  } catch (e) {
    console.warn("could not stop iframe loading:", e, NEGATIVE);
  }

  updateTabDetails(iframe);

  hideLoading(tabId ?? undefined);
  syncGlobalLoadingState();
  iframe.parentElement?.classList.add("loaded");

  const tab = window.Lyra?.tabs?.find((tab) => tab.iframe === iframe);
  tab?.historyManager?.cancel();
  const currentUrl = getBestKnownUrl(iframe, tab);

  if (tab && currentUrl && currentUrl !== "about:blank") {
    updateHistoryUI(tab, {
      currentUrl: tab.historyManager?.getCurrentUrl?.() ?? currentUrl,
      canGoBack: tab.historyManager?.canGoBack?.() ?? false,
      canGoForward: tab.historyManager?.canGoForward?.() ?? false,
    });
  }
}

export function navigateIframeTo(
  iframe: HTMLIFrameElement,
  url: string,
  mode: "push" | "replace" = "push",
): void {
  if (!url || !iframe) return;
  const navigationVersion = beginNavigation(iframe);
  clearExtensionPageForNavigation(iframe);
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const tab = window.Lyra.tabs!.find((t) => t.iframe === iframe);
  tab?.historyManager?.begin(mode);
  iframe.dataset.navigationVersion = String(navigationVersion);
  const historyManager = iframeExt.__lyraHistoryManager as
    IframeHistoryManager | undefined;
  if (historyManager) {
    installIframeLoadHandlers(
      iframe,
      historyManager,
      tab?.id ??
        (iframeExt.__lyraTabId as number | null | undefined) ??
        getTabIdFromIframe(iframe),
      navigationVersion,
    );
  }
  if (tab) {
    updateHistoryUI(tab, {
      currentUrl: url,
      canGoBack: tab.historyManager?.canGoBack?.() ?? false,
      canGoForward: tab.historyManager?.canGoForward?.() ?? false,
    });
  }
  showLoading((tab?.id || getTabIdFromIframe(iframe)) ?? undefined);
  if (tab) getRivet()?.notifyTabUpdated(tab.id, { status: "loading", url });
  window.Lyra.isLoading = true;
  delete iframe.dataset.reloadAttempted;
  iframe.parentElement?.classList.remove("loaded");

  if (tab) {
    delete tab.pageState;
    if (!tab.fixedTitle) {
      tab.title = "fetching data...";
    }
    if (!tab.fixedFavicon) {
      tab.favicon = null;
    }
    if (window.Lyra.renderTabs) (window.Lyra.renderTabs as () => void)();
  }

  iframe.dataset.navigationStarted = "true";
  iframe.removeAttribute("srcdoc");
  delete iframe.dataset.manualUrl;
  clearGameLoadState(iframe, true);
  armGameLoadTimeout(
    iframe,
    navigationVersion,
    tab?.id ?? getTabIdFromIframe(iframe),
  );

  const shouldUseFolio = shouldRouteThroughFolio(url);
  let isProxyUrl = false;
  try {
    const parsed = new URL(url, window.location.origin);
    isProxyUrl =
      parsed.origin === window.location.origin &&
        parsed.pathname === appPath("/f") &&
      parsed.searchParams.has("s");
  } catch {}
  if (shouldUseFolio) {
    void navigateExternalThroughFolio(iframe, url, navigationVersion).catch(
      (error) => {
        if (!isCurrentNavigation(iframe, navigationVersion)) return;
        console.error(
          "iframe navigation through folio failed:",
          error,
          NEGATIVE,
        );
        failGameNavigation(iframe, tab?.id ?? getTabIdFromIframe(iframe));
      },
    );
  } else if (isProxyUrl && window.Lyra?.waitForTransport) {
    void waitForNavigationTransport(false).then(() => {
      if (!isCurrentNavigation(iframe, navigationVersion)) return;
      iframe.src = url;
    });
  } else {
    iframe.src = url;
  }
}

export function clearExtensionPageForNavigation(
  iframe: HTMLIFrameElement,
  tabOverride?: Pick<LyraTab, "extensionPage" | "fixedTitle" | "fixedFavicon">,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const cleanup = iframeExt.__rivetExtensionPageCleanup;
  if (typeof cleanup === "function") {
    cleanup();
    if (iframeExt.__rivetExtensionPageCleanup === cleanup) {
      delete iframeExt.__rivetExtensionPageCleanup;
    }
  }
  const tab =
    tabOverride ??
    window.Lyra.tabs?.find((candidate) => candidate.iframe === iframe);
  if (!tab?.extensionPage) return;
  delete tab.extensionPage;
  tab.fixedTitle = false;
  tab.fixedFavicon = false;
  delete iframe.dataset.manualUrl;
}

export function cleanupIframe(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  beginNavigation(iframe);
  window.Lyra?.releaseFolioFrame?.(iframe);
  clearExtensionPageForNavigation(iframe);
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  clearGameLoadState(iframe, true);
  const handlers = iframeExt.__lyraInternalHandlers as
    IframeInternalHandlers | null | undefined;
  if (handlers) {
    iframe.removeEventListener("error", handlers.onError);
    iframe.removeEventListener("load", handlers.onLoad);
    iframeExt.__lyraInternalHandlers = null;
  }
  detachContentWindowListeners(iframe);
  iframe.removeAttribute("srcdoc");
  iframe.removeAttribute("data-navigation-started");
  iframe.removeAttribute("data-reload-attempted");
  iframe.removeAttribute("data-manual-url");
  delete iframe.dataset.reloadCount;
  try {
    iframe.contentWindow?.stop?.();
  } catch (e) {}
  try {
    iframe.src = "about:blank";
  } catch (e) {}
  const wrapper = iframe.parentElement;
  if (wrapper) {
    wrapper.style.boxShadow = "";
    wrapper.classList.remove(
      "loaded",
      "active",
      "active-split-left",
      "active-split-right",
      "active-focus",
    );
  }
}

function updateTabDetails(iframe: HTMLIFrameElement): void {
  const tabToUpdate = window.Lyra.tabs!.find((tab) => tab.iframe === iframe);
  if (!tabToUpdate) return;
  const usedPageState = applyPageStateToTab(tabToUpdate);
  if (usedPageState) {
    if (window.Lyra.renderTabs) (window.Lyra.renderTabs as () => void)();
    return;
  }
  const prevTitle = tabToUpdate.title;
  const prevFavicon = tabToUpdate.favicon;
  let isReloading = false;
  try {
    const iframeWindow = iframe.contentWindow!;
    const doc = iframeWindow.document;
    const currentProxiedUrl =
      iframe.dataset.manualUrl || iframeWindow.location.href;
    const realUrl = decodeUrl(currentProxiedUrl);

    const newTitle = (doc.title || "").trim();
    if (!tabToUpdate.fixedTitle) {
      if (newTitle) {
        tabToUpdate.title = newTitle;
      } else if (tabToUpdate.title === "fetching data...") {
        try {
          tabToUpdate.title = new URL(realUrl).hostname || "new tab";
        } catch (e) {
          tabToUpdate.title = "new tab";
        }
      }
    }

    if (
      tabToUpdate.title === "404!!" ||
      tabToUpdate.title === "Folio" ||
      tabToUpdate.title === "Error"
    ) {
      const MAX_RELOADS = 3;
      const MIN_INTERVAL_MS = 1200;
      const reloadCount = parseInt(iframe.dataset.reloadCount || "0", 10);
      const lastReloadAt = parseInt(iframe.dataset.lastReloadAt || "0", 10);
      const now = Date.now();
      const cooldownReached =
        !lastReloadAt || now - lastReloadAt > MIN_INTERVAL_MS;
      const isActiveTab = document.body.classList.contains("split-view")
        ? tabToUpdate.id === (window.Lyra as any)?.splitPair?.left ||
          tabToUpdate.id === (window.Lyra as any)?.splitPair?.right ||
          tabToUpdate.id === (window.Lyra as any)?.getActiveTab?.()?.id
        : tabToUpdate.id === (window.Lyra as any)?.getActiveTab?.()?.id;
      if (reloadCount < MAX_RELOADS && cooldownReached && isActiveTab) {
        iframe.dataset.reloadCount = (reloadCount + 1).toString();
        iframe.dataset.lastReloadAt = now.toString();
        isReloading = true;
        iframe.parentElement?.classList.remove("loaded");

        const currentUrl =
          pageStateUrl(tabToUpdate) ||
          iframe.dataset.manualUrl ||
          decodeUrl(iframe.src);
        navigateIframeTo(iframe, currentUrl);
        return;
      }
    }
    const iconLink = doc.querySelector("link[rel*='icon']");
    if (!tabToUpdate.fixedFavicon) {
      const gameCover = getLoadedGameCover(realUrl);

      if (gameCover) {
        tabToUpdate.favicon = gameCover;
      } else if (iconLink) {
        const decodedFavicon = decodeUrl((iconLink as HTMLLinkElement).href);
        tabToUpdate.favicon = decodedFavicon
          ? getProxyUrl(decodedFavicon)
          : null;
      } else {
        try {
          tabToUpdate.favicon = getProxyUrl(
            new URL("favicon.ico", realUrl).href,
          );
        } catch (e) {
          tabToUpdate.favicon = null;
        }
      }
    }
  } catch (e) {
    tabToUpdate.title = prevTitle || "new tab";
    if (!tabToUpdate.fixedFavicon) {
      const proxyUrl = iframe.dataset.manualUrl || iframe.src;
      const gameCover = getLoadedGameCover(decodeUrl(proxyUrl));
      tabToUpdate.favicon = gameCover || prevFavicon || null;
    }
  } finally {
    if (!isReloading && window.Lyra.renderTabs)
      (window.Lyra.renderTabs as () => void)();
  }
}

function setupIframeContentListeners(
  iframe: HTMLIFrameElement,
  historyManager: NonNullable<LyraTab["historyManager"]>,
  tabId: number | null,
): void {
  try {
    const iframeWindow = iframe.contentWindow;
    const hasManualUrl = !!iframe.dataset.manualUrl;
    const isBlank = iframeWindow?.location?.href === "about:blank";
    if (!iframeWindow || iframeWindow === window || (isBlank && !hasManualUrl))
      return;

    detachContentWindowListeners(iframe);
    const listeners: ContentWindowListeners = {};
    contentWindowListeners.set(iframeWindow, listeners);
    const navigation = iframeWindow.navigation;
    const hasPageStatePlugin = folioPageStateDocuments.has(
      iframeWindow.document,
    );
    if (navigation && !hasPageStatePlugin) {
      const onEntryChange = (event: NavigationCurrentEntryChangeEvent) => {
        const url = navigationUrl(iframeWindow.location.href);
        historyManager.observe(
          url,
          event.navigationType ?? "metadata",
          navigation.currentEntry?.key,
        );
      };
      navigation.addEventListener("currententrychange", onEntryChange);
      listeners.historyCleanup = () =>
        navigation.removeEventListener("currententrychange", onEntryChange);
    }

    const handleNav = (type = "history-push"): void => {
      const newUrlInIframe = iframeWindow.location.href;
      const baseManualUrl = iframe.dataset.manualUrl;
      let finalUrlToPush = newUrlInIframe;
      if (baseManualUrl && newUrlInIframe.startsWith("about:blank")) {
        try {
          const newUrlObj = new URL(newUrlInIframe, window.location.origin);
          const baseManualUrlObj = new URL(baseManualUrl);
          baseManualUrlObj.hash = newUrlObj.hash;
          baseManualUrlObj.search = newUrlObj.search;
          finalUrlToPush = baseManualUrlObj.toString();
        } catch (e) {
          finalUrlToPush = newUrlInIframe;
        }
      }
      if (finalUrlToPush !== "about:blank") {
        historyManager.observe(navigationUrl(finalUrlToPush), type);
      }
    };

    if (
      !navigation &&
      !hasPageStatePlugin &&
      !(iframeWindow.history.pushState as any).__isPatched
    ) {
      const originalPushState = iframeWindow.history.pushState;
      (iframeWindow as any).history.pushState = function (
        ...args: Parameters<typeof History.prototype.pushState>
      ) {
        originalPushState.apply(this, args);
        handleNav();
      };
      (iframeWindow.history.pushState as any).__isPatched = true;
    }
    if (
      !navigation &&
      !hasPageStatePlugin &&
      !(iframeWindow.history.replaceState as any).__isPatched
    ) {
      const originalReplaceState = iframeWindow.history.replaceState;
      (iframeWindow as any).history.replaceState = function (
        ...args: Parameters<typeof History.prototype.replaceState>
      ) {
        originalReplaceState.apply(this, args);
        handleNav("history-replace");
      };
      (iframeWindow.history.replaceState as any).__isPatched = true;
    }

    if (!navigation && !hasPageStatePlugin) {
      const onPopState = () => handleNav("popstate");
      const onHashChange = () => handleNav("hashchange");
      iframeWindow.addEventListener("popstate", onPopState);
      iframeWindow.addEventListener("hashchange", onHashChange);
      listeners.historyCleanup = () => {
        iframeWindow.removeEventListener("popstate", onPopState);
        iframeWindow.removeEventListener("hashchange", onHashChange);
      };
    }

    const beforeUnloadHandler = () => {
      showLoading(tabId ?? undefined);
      window.Lyra.isLoading = true;
      iframe.parentElement?.classList.remove("loaded");
      const tab = window.Lyra.tabs!.find((t) => t.id === tabId);
      if (tab) {
        if (!tab.fixedTitle) {
          tab.title = "fetching data...";
        }
        if (!tab.fixedFavicon) {
          tab.favicon = null;
        }
        if (window.Lyra.renderTabs) (window.Lyra.renderTabs as () => void)();
      }
    };
    listeners.beforeUnload = beforeUnloadHandler;
    iframeWindow.addEventListener("beforeunload", beforeUnloadHandler);

    const domLoadedHandler = () => {
      updateTabDetails(iframe);
    };
    listeners.domContentLoaded = domLoadedHandler;
    iframeWindow.addEventListener("DOMContentLoaded", domLoadedHandler);

    const mouseDownHandler = () => {
      const focusEvent = new CustomEvent("iframe-focus", {
        detail: { tabId },
        bubbles: false,
      });
      iframe.dispatchEvent(focusEvent);
    };
    listeners.focus = mouseDownHandler;
    iframeWindow.addEventListener("mousedown", mouseDownHandler, true);
  } catch (e) {
    console.warn("could not attach listeners to iframe content", NEGATIVE);
  }
}

function installIframeLoadHandlers(
  iframe: HTMLIFrameElement,
  historyManager: IframeHistoryManager,
  tabId: number | null,
  navigationVersion: number,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const previousHandlers = iframeExt.__lyraInternalHandlers as
    IframeInternalHandlers | null | undefined;
  if (previousHandlers) {
    iframe.removeEventListener("error", previousHandlers.onError);
    iframe.removeEventListener("load", previousHandlers.onLoad);
  }

  const onError = (): void => {
    if (!isCurrentNavigation(iframe, navigationVersion)) return;
    const tab = failGameNavigation(iframe, tabId);
    if (tab) getRivet()?.notifyTabUpdated(tab.id, { status: "complete" });
  };

  const onLoad = (): void => {
    if (!isCurrentNavigation(iframe, navigationVersion)) return;
    if (iframeExt.__gameLoadTerminal === "error") return;
    const tab = window.Lyra?.tabs?.find((tab) => tab.iframe === iframe);
    if (tab?.isGame && isKnownGameErrorDocument(iframe)) {
      failGameNavigation(iframe, tabId);
      updateTabDetails(iframe);
      return;
    }
    iframeExt.__gameLoadTerminal = "success";
    finishGameLoadMetric(iframe, "success");

    if (tab?.isGame && tab.playerStatus === "error") {
      window.Lyra.setPlayerStatus?.(tab.id, "idle");
    }
    let newUrl: string | undefined;
    try {
      const win = iframe.contentWindow;
      const nativeUrl = win?.location.href;
      if (nativeUrl && nativeUrl !== "about:blank") {
        newUrl = navigationUrl(nativeUrl);
        if (!win || !folioPageStateDocuments.has(win.document)) {
          historyManager.observe(
            newUrl,
            win?.navigation?.activation?.navigationType ?? "load",
            win?.navigation?.currentEntry?.key,
          );
        }
      }
    } catch {}

    updateTabDetails(iframe);

    hideLoading(tabId ?? undefined);
    syncGlobalLoadingState();
    iframe.parentElement?.classList.add("loaded");

    if (tab) {
      getRivet()?.notifyTabUpdated(tab.id, {
        status: "complete",
        ...(newUrl ? { url: newUrl } : {}),
        title: tab.title,
        favIconUrl: tab.favicon ?? "",
      });
    }

    setupIframeContentListeners(iframe, historyManager, tabId);
  };

  iframe.addEventListener("error", onError);
  iframe.addEventListener("load", onLoad);
  iframeExt.__lyraInternalHandlers = {
    onError,
    onLoad,
    version: navigationVersion,
  } satisfies IframeInternalHandlers;
}

export function initializeIframe(
  iframe: HTMLIFrameElement,
  historyManager: IframeHistoryManager,
  tabId: number | null,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  iframeExt.__lyraHistoryManager = historyManager;
  iframeExt.__lyraTabId = tabId;
  installIframeLoadHandlers(
    iframe,
    historyManager,
    tabId,
    navigationVersions.get(iframe) ?? 0,
  );
}
