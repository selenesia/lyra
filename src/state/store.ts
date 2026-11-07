import { create } from "zustand";
import { HistoryManager } from "../core/browser/history.ts";
import { initializeIframe, cleanupIframe } from "../core/browser/iframe.ts";
import { updateHistoryUI } from "../core/browser/historyUI.ts";
import { handleSearch as performSearch } from "../features/search/search.ts";
import {
  encodeMochiUrl,
  normalizeGameHistoryUrl,
} from "../core/runtime/utils.ts";
import {
  getRivet,
  mountRivetNewTabOverride,
} from "../core/proxy/rivetBridge.ts";
import { getStoredGameSource } from "../core/config/settingsOptions.ts";

export function proxyGameFavicon(icon: string): string {
  if (!icon || icon.startsWith("/")) return icon;
  return `/!cover!/${encodeMochiUrl(icon)}/`;
}

const PLAYER_STATUSES = [
  "idle",
  "loading",
  "buffering",
  "waiting",
  "stalled",
  "playing",
  "paused",
  "ended",
  "error",
] as const;

export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

export function isPlayerStatus(value: string): value is PlayerStatus {
  return (PLAYER_STATUSES as readonly string[]).includes(value);
}

export interface Tab {
  id: number;
  title: string;
  favicon: string | null;
  iframe: HTMLIFrameElement;
  wrapper: HTMLDivElement;
  historyManager: HistoryManager;
  isUrlLoaded: boolean;
  isLoading: boolean;
  playerStatus: PlayerStatus;
  openerTabId: number | null;
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
  _iframeFocusHandler: EventListener | null;
  _iframeElementFocusHandler: EventListener | null;
}

interface AddTabOptions {
  applyNewTabOverride?: boolean;
  active?: boolean;
  openerTabId?: number | null;
}

type TabPageState = NonNullable<Tab["pageState"]>;

export const clientTabMap = new Map<string, number>();
export const tabMemory = new Map<number, unknown>();
let lastTabId = 0;

export const useStore = create<{
  tabs: Tab[];
  activeTabId: number | null;
  splitPair: { left: number | null; right: number | null };
  isPickingSplitTab: boolean;
  isLoading: boolean;
}>(() => ({
  tabs: [],
  activeTabId: null,
  splitPair: { left: null, right: null },
  isPickingSplitTab: false,
  isLoading: false,
}));

let syncedTabsSignature = "";
let syncedSplitLeft: number | null = null;
let syncedSplitRight: number | null = null;

function tabsSignature(tabs: readonly Tab[]): string {
  return tabs
    .map(
      (tab) =>
        `${tab.id}\u0000${tab.title}\u0000${tab.favicon ?? ""}\u0000${
          tab.isLoading ? 1 : 0
        }\u0000${tab.isUrlLoaded ? 1 : 0}\u0000${tab.playerStatus}`,
    )
    .join("\u0001");
}

function syncToZustand(s: {
  tabs: Tab[];
  activeTabId: number | null;
  splitPair: { left: number | null; right: number | null };
  isPickingSplitTab: boolean;
  isLoading: boolean;
}) {
  const current = useStore.getState();
  const next: Partial<typeof current> = {};
  const nextTabsSignature = tabsSignature(s.tabs);
  if (nextTabsSignature !== syncedTabsSignature) {
    syncedTabsSignature = nextTabsSignature;
    next.tabs = [...s.tabs];
  }
  if (current.activeTabId !== s.activeTabId) {
    next.activeTabId = s.activeTabId;
  }
  if (
    syncedSplitLeft !== s.splitPair.left ||
    syncedSplitRight !== s.splitPair.right
  ) {
    syncedSplitLeft = s.splitPair.left;
    syncedSplitRight = s.splitPair.right;
    next.splitPair = { ...s.splitPair };
  }
  if (current.isPickingSplitTab !== s.isPickingSplitTab) {
    next.isPickingSplitTab = s.isPickingSplitTab;
  }
  if (current.isLoading !== s.isLoading) next.isLoading = s.isLoading;
  if (Object.keys(next).length > 0) useStore.setState(next);
}

const buildGameDisplayLabel = (title: unknown) => {
  const safeTitle = String(title || "")
    .trim()
    .toLowerCase();
  if (!safeTitle) return null;
  const source = getStoredGameSource();
  return `game: ${safeTitle} / source: ${source}`;
};

export const rememberTabGameLabel = (tab: Tab, url: string | null, title: unknown) => {
  if (!tab || !url) return;
  const normalized = normalizeGameHistoryUrl(url);
  const label = buildGameDisplayLabel(title);
  if (!normalized || !label) return;
  if (!tab.gameDisplayByUrl) tab.gameDisplayByUrl = {};
  tab.gameDisplayByUrl[normalized] = label;
};

function disposeTabFrame(tab: Tab) {
  tab.iframe.removeEventListener("iframe-focus", tab._iframeFocusHandler!);
  tab.iframe.removeEventListener("focus", tab._iframeElementFocusHandler!);
  tab.iframe.removeEventListener("pointerdown", tab._iframeElementFocusHandler!);
  tab.iframe.removeEventListener("mouseenter", tab._iframeElementFocusHandler!);
  cleanupIframe(tab.iframe);
  tab.wrapper?.remove();
}

export const store = {
  tabs: [] as Tab[],
  activeTabId: null as number | null,
  splitPair: { left: null as number | null, right: null as number | null },
  isPickingSplitTab: false,
  isLoading: false,

  notify() {
    syncToZustand(this);
  },

  getActiveTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  },

  getActivePageState(): TabPageState | null {
    return this.getActiveTab()?.pageState || null;
  },

  getTabPageState(tabId: number): TabPageState | null {
    return this.tabs.find((tab) => tab.id === tabId)?.pageState || null;
  },

  getReusableActiveTab(): Tab | null {
    const tab = this.getActiveTab();
    if (!tab || tab.isUrlLoaded || tab.extensionPage || tab.pageState?.url) {
      return null;
    }
    if (tab.historyManager?.getCurrentUrl?.()) return null;
    if (tab.iframe.dataset.manualUrl) return null;
    const frameSrc = tab.iframe.getAttribute("src");
    if (frameSrc && frameSrc !== "about:blank") return null;
    return tab;
  },

  createIframe(): { iframe: HTMLIFrameElement; wrapper: HTMLDivElement } {
    const wrapper = document.createElement("div");
    wrapper.className = "iframe";
    const iframe = document.createElement("iframe");
    iframe.allow =
      "fullscreen; camera; microphone; display-capture; clipboard-read; clipboard-write; autoplay; cross-origin-isolated;";
    iframe.referrerPolicy = "no-referrer";
    iframe.tabIndex = -1;
    wrapper.appendChild(iframe);
    const container = document.getElementById("iframe-container");
    if (container) container.appendChild(wrapper);
    return { iframe, wrapper };
  },

  addTab(
    url: string | null = null,
    title = "new tab",
    isGame = false,
    icon: string | null = null,
    options: AddTabOptions = {},
  ): Tab {
    const safeTitle = typeof title === "string" ? title : "new tab";
    const newTabId = (lastTabId = Math.max(Date.now(), lastTabId + 1));
    const { iframe, wrapper } = this.createIframe();
    iframe.dataset.tabId = String(newTabId);
    iframe.name = newTabId.toString();

    const historyManager = new HistoryManager({
      onUpdate: (history) => {
        const activeTab = this.getActiveTab();
        if (activeTab?.id === newTabId) {
          updateHistoryUI(activeTab as never, history);
        }
      },
    });

    const newTab: Tab = {
      id: newTabId,
      title: safeTitle,
      favicon: null,
      iframe: iframe,
      wrapper: wrapper,
      historyManager: historyManager,
      isUrlLoaded: !!url,
      isLoading: false,
      playerStatus: "idle",
      openerTabId: options.openerTabId ?? null,
      isGame,
      _iframeFocusHandler: null,
      _iframeElementFocusHandler: null,
    };

    if (isGame) {
      newTab.fixedTitle = true;
      newTab.title = safeTitle;
      rememberTabGameLabel(newTab, url, safeTitle);
    }
    if (icon) {
      newTab.fixedFavicon = true;
      newTab.favicon = proxyGameFavicon(icon);
    }

    const iframeFocusHandler = (e: CustomEvent) => {
      const clickedTabId = (e.detail as { tabId: number }).tabId;
      if (document.body.classList.contains("split-view")) {
        const isSplitTab =
          clickedTabId === this.splitPair.left ||
          clickedTabId === this.splitPair.right;
        const isNotActive = clickedTabId !== this.activeTabId;
        if (isSplitTab && isNotActive) {
          this.switchTab(clickedTabId);
        }
      }
    };

    const iframeElementFocusHandler = (evt: Event) => {
      const isSplitView = document.body.classList.contains("split-view");
      const isSplitTab =
        newTabId === this.splitPair.left || newTabId === this.splitPair.right;

      if (
        evt?.type === "mouseenter" &&
        (!isSplitView || this.activeTabId === newTabId)
      )
        return;
      if (evt?.type === "pointerdown") {
        try {
          iframe.focus({ preventScroll: true });
        } catch (e) {}
      }
      if (isSplitView && isSplitTab && this.activeTabId !== newTabId) {
        this.switchTab(newTabId);
        return;
      }
      const focusEvent = new CustomEvent("iframe-focus", {
        detail: { tabId: newTabId },
        bubbles: false,
      });
      iframe.dispatchEvent(focusEvent);
    };

    newTab._iframeFocusHandler = iframeFocusHandler as EventListener;
    newTab._iframeElementFocusHandler = iframeElementFocusHandler;

    iframe.addEventListener(
      "iframe-focus",
      iframeFocusHandler as EventListener,
    );
    iframe.addEventListener("focus", iframeElementFocusHandler);
    iframe.addEventListener("pointerdown", iframeElementFocusHandler);
    iframe.addEventListener("mouseenter", iframeElementFocusHandler);

    const openerIndex = this.tabs.findIndex(
      (tab) => tab.id === newTab.openerTabId,
    );
    let insertIndex = this.tabs.length;
    if (openerIndex !== -1) {
      insertIndex = openerIndex + 1;
      if (options.active === false) {
        while (this.tabs[insertIndex]?.openerTabId === newTab.openerTabId)
          insertIndex++;
      }
    } else newTab.openerTabId = null;
    this.tabs.splice(insertIndex, 0, newTab);
    initializeIframe(iframe, historyManager, newTab.id);

    if (!url && options.applyNewTabOverride !== false) {
      mountRivetNewTabOverride(newTab);
    }

    if (url) {
      performSearch(url, newTab as never, isGame ? title : undefined);
    }

    getRivet()?.notifyTabCreated(newTabId);
    if (options.active !== false || this.activeTabId === null)
      this.switchTab(newTabId);
    else this.notify();
    return newTab;
  },

  switchTab(tabId: number) {
    if (!this.tabs.some((tab) => tab.id === tabId)) return;
    const previousActiveId = this.activeTabId;

    if (!this.isPickingSplitTab && previousActiveId === tabId) return;

    if (this.isPickingSplitTab) {
      if (tabId === this.splitPair.left) return;
      this.splitPair.right = tabId;
      this.isPickingSplitTab = false;
      this.activeTabId = this.splitPair.left;
    } else {
      this.activeTabId = tabId;
    }

    const activeTab = this.getActiveTab();
    if (activeTab) {
      const isSplitViewActive =
        this.splitPair.left !== null &&
        this.splitPair.right !== null &&
        (this.activeTabId === this.splitPair.left ||
          this.activeTabId === this.splitPair.right);

      if (activeTab.isUrlLoaded || isSplitViewActive) {
        document.body.classList.add("browser-view");
      } else {
        document.body.classList.remove("browser-view");
      }
    } else {
      document.body.classList.remove("browser-view");
    }

    this.updateIframeView();
    if (this.activeTabId !== previousActiveId && this.activeTabId !== null) {
      getRivet()?.notifyTabActivated(this.activeTabId);
    }
  },

  closeTab(tabId: number) {
    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) return;

    const closedTab = this.tabs.splice(tabIndex, 1)[0]!;

    if (closedTab.iframe) {
      disposeTabFrame(closedTab);
      closedTab._iframeFocusHandler = null;
      closedTab._iframeElementFocusHandler = null;
      (closedTab as any).iframe = null;
    }

    if (closedTab.historyManager?.destroy) {
      closedTab.historyManager.destroy();
      (closedTab as any).historyManager = null;
    }
    tabMemory.delete(tabId);
    for (const [clientId, id] of clientTabMap) {
      if (id === tabId) clientTabMap.delete(clientId);
    }

    const wasInSplitPair =
      tabId === this.splitPair.left || tabId === this.splitPair.right;
    if (wasInSplitPair) {
      this.splitPair.left = null;
      this.splitPair.right = null;
      this.isPickingSplitTab = false;
    }

    const wasActive = this.activeTabId === tabId;
    const nextActiveTabId = wasActive
      ? (this.tabs.find((tab) => tab.openerTabId === tabId)?.id ??
        (closedTab.openerTabId === null
          ? undefined
          : (this.tabs.find(
              (tab, index) =>
                index >= tabIndex && tab.openerTabId === closedTab.openerTabId,
            )?.id ??
            this.tabs.findLast(
              (tab, index) =>
                index < tabIndex && tab.openerTabId === closedTab.openerTabId,
            )?.id)) ??
        this.tabs.find((tab) => tab.id === closedTab.openerTabId)?.id ??
        this.tabs[tabIndex]?.id ??
        this.tabs[tabIndex - 1]?.id ??
        null)
      : null;
    for (const tab of this.tabs) {
      if (tab.openerTabId === tabId) tab.openerTabId = closedTab.openerTabId;
    }
    if (wasActive) {
      this.activeTabId = null;
    }

    getRivet()?.notifyTabRemoved(tabId);

    if (this.tabs.length === 0) {
      this.addTab(null, "new tab");
    } else if (nextActiveTabId !== null) {
      this.switchTab(nextActiveTabId);
    } else if (this.activeTabId === null) {
      this.switchTab(this.tabs[0]!.id);
    } else {
      this.updateIframeView();
    }
  },

  updateIframeView() {
    const isSplitPairDefined =
      this.splitPair.left !== null &&
      this.splitPair.right !== null &&
      this.tabs.some((t) => t.id === this.splitPair.left) &&
      this.tabs.some((t) => t.id === this.splitPair.right);

    if (!isSplitPairDefined && !this.isPickingSplitTab) {
      this.splitPair.left = null;
      this.splitPair.right = null;
    }

    const isSplitViewActive =
      isSplitPairDefined &&
      (this.activeTabId === this.splitPair.left ||
        this.activeTabId === this.splitPair.right);
    const isPicking = this.isPickingSplitTab;

    if (isSplitViewActive) this.isPickingSplitTab = false;

    document.body.classList.toggle("split-view", isSplitViewActive);
    document.body.classList.toggle("is-picking-split", isPicking);

    let leftIframe = null as HTMLDivElement | null;
    let rightIframe = null as HTMLDivElement | null;

    this.tabs.forEach((tab) => {
      tab.wrapper.classList.remove("active-focus");
      const isSplitLeft =
        (isSplitViewActive && tab.id === this.splitPair.left) ||
        (isPicking && tab.id === this.splitPair.left);
      const isSplitRight = isSplitViewActive && tab.id === this.splitPair.right;
      const isSingleActive =
        !isSplitViewActive && !isPicking && tab.id === this.activeTabId;

      tab.wrapper.classList.toggle("active-split-left", isSplitLeft);
      tab.wrapper.classList.toggle("active-split-right", isSplitRight);
      tab.wrapper.classList.toggle("active", isSingleActive);

      const isActiveFocus =
        (isSplitViewActive || isPicking) && tab.id === this.activeTabId;
      if (isActiveFocus) tab.wrapper.classList.add("active-focus");

      tab.wrapper.classList.toggle(
        "split-focus-shadow",
        isActiveFocus && (isSplitViewActive || isPicking),
      );

      if (isSplitLeft) leftIframe = tab.wrapper;
      if (isSplitRight) rightIframe = tab.wrapper;

      if (!isSplitViewActive && !isPicking) {
        const wrapper = tab.wrapper;
        if (wrapper.style.width) wrapper.style.width = "";
        if (wrapper.style.flexBasis) wrapper.style.flexBasis = "";
        if (wrapper.style.flexGrow) wrapper.style.flexGrow = "";
      }
    });

    if ((isSplitViewActive || isPicking) && leftIframe) {
      let leftBasis = leftIframe.style.flexBasis;
      if (!leftBasis || leftBasis === "auto" || leftBasis === "0px") {
        leftBasis = `calc(50%)`;
      }
      leftIframe.style.flexGrow = "0";
      leftIframe.style.flexBasis = leftBasis;
      if (rightIframe) {
        rightIframe.style.flexGrow = "1";
        rightIframe.style.flexBasis = "0";
      }
    }

    const activeTab = this.getActiveTab();
    if (activeTab) {
      updateHistoryUI(activeTab as never, {
        currentUrl: activeTab.historyManager.getCurrentUrl(),
        canGoBack: activeTab.historyManager.canGoBack(),
        canGoForward: activeTab.historyManager.canGoForward(),
      });
    }

    this.notify();
  },

  showLoading(tabId: number | null = null) {
    const target = tabId
      ? this.tabs.find((t) => t.id === tabId)
      : this.getActiveTab();
    if (target) {
      target.isLoading = true;
      target.playerStatus = "idle";
    }

    const resolvedTabId = (tabId || this.getActiveTab()?.id) ?? null;
    const activeId = this.getActiveTab()?.id ?? null;
    const isSplitView = document.body.classList.contains("split-view");
    const isInSplit =
      isSplitView &&
      this.splitPair &&
      (resolvedTabId === this.splitPair.left ||
        resolvedTabId === this.splitPair.right);

    if (!isInSplit && (!activeId || (tabId && activeId !== tabId))) return;

    if (!tabId || tabId === activeId) {
      this.notify();
    }
  },

  hideLoading(tabId: number | null = null) {
    const target = tabId
      ? this.tabs.find((t) => t.id === tabId)
      : this.getActiveTab();
    if (target) target.isLoading = false;

    const activeId = this.getActiveTab()?.id ?? null;
    const isSplitView = document.body.classList.contains("split-view");
    const isInSplit =
      isSplitView &&
      this.splitPair &&
      (tabId === this.splitPair?.left || tabId === this.splitPair?.right);

    if (!isInSplit && tabId && activeId && tabId !== activeId) return;

    if (!tabId || tabId === activeId) {
      this.notify();
    }
  },

  setPlayerStatus(tabId: number | null, status: PlayerStatus) {
    const target = tabId
      ? this.tabs.find((tab) => tab.id === tabId)
      : this.getActiveTab();
    if (!target || target.playerStatus === status) return;
    target.playerStatus = status;
    this.notify();
  },

  toggleSplitView() {
    const isSplitPairDefined =
      this.splitPair.left !== null && this.splitPair.right !== null;
    if (this.tabs.length <= 1 && !this.isPickingSplitTab && !isSplitPairDefined)
      return;

    if (this.isPickingSplitTab) {
      this.isPickingSplitTab = false;
    } else if (isSplitPairDefined) {
      this.splitPair.left = null;
      this.splitPair.right = null;
    } else {
      this.isPickingSplitTab = true;
      this.splitPair.left = this.activeTabId;
    }

    this.updateIframeView();
  },

  resetSession() {
    if (
      typeof window !== "undefined" &&
      typeof window.dispatchEvent === "function"
    ) {
      window.dispatchEvent(new CustomEvent("rivet-close-extension-popup"));
    }
    const tabsCopy = [...this.tabs];
    for (const tab of tabsCopy) {
      if (tab.iframe) disposeTabFrame(tab);
      if (tab.historyManager?.destroy) tab.historyManager.destroy();
    }

    this.tabs.length = 0;
    tabMemory.clear();
    clientTabMap.clear();
    this.activeTabId = null;
    this.splitPair.left = null;
    this.splitPair.right = null;
    this.isPickingSplitTab = false;

    const container = document.getElementById("iframe-container");
    if (container)
      container.innerHTML = '<div id="iframe-resize-divider"></div>';
    document.body.classList.remove(
      "split-view",
      "is-picking-split",
      "is-resizing",
      "browser-view",
    );

    this.addTab(null, "new tab", false, null, {
      applyNewTabOverride: false,
    });
    this.notify();
  },
};

export function showLoading(tabId?: number) {
  store.showLoading(tabId);
}
export function hideLoading(tabId?: number) {
  store.hideLoading(tabId);
}
export function showBrowserView() {
  document.body.classList.add("browser-view");
}
export function showHomeView() {
  document.body.classList.remove("browser-view");
}
