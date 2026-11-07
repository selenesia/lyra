import {
  clearExtensionPageForNavigation,
  historyEntry,
} from "../core/browser/iframe.ts";
import { updateHistoryUI } from "../core/browser/historyUI.ts";
import { getRivet } from "../core/proxy/rivetBridge.ts";
import { getProxyUrl } from "../core/runtime/utils.ts";
import { store, type Tab, clientTabMap, tabMemory } from "./store.ts";

const decodePageMetadata = (encoded: string) => {
  if (!encoded) return null;
  const key = "wb!";
  try {
    const bytes = atob(encoded);
    let decoded = "";
    for (let index = 0; index < bytes.length; index++) {
      decoded += String.fromCharCode(
        bytes.charCodeAt(index) ^ key.charCodeAt(index % key.length),
      );
    }
    return decodeURIComponent(decoded);
  } catch {
    return encoded;
  }
};

export function handleServiceWorkerMessage(event: MessageEvent) {
  const { data } = event;
  if (data && data.type === "open-new-tab") {
    const targetUrl = data.decodedUrl || data.url || null;
    if (!targetUrl) return;
    const openerTabId = Number(data.tabId) || null;
    if (
      openerTabId !== null &&
      !store.tabs.some((tab) => tab.id === openerTabId)
    )
      return;
    const title =
      typeof data.title === "string" ? data.title : "fetching data...";
    store.addTab(targetUrl, title, false, null, {
      openerTabId,
      active: data.active !== false,
    });
    return;
  }
  if (data && data.type === "page-meta") {
    const isEncoded = !!data.encoded;
    const incomingUrl = isEncoded
      ? decodePageMetadata(data.decodedUrl || data.url)
      : data.decodedUrl || data.url || data.href || null;
    const incomingDecodedUrl = isEncoded
      ? decodePageMetadata(data.decodedUrl)
      : data.decodedUrl || data.url || data.href || null;
    const incomingTitle = isEncoded
      ? decodePageMetadata(data.title)
      : typeof data.title === "string"
        ? data.title
        : "";
    const incomingFavicon = isEncoded
      ? decodePageMetadata(data.favicon)
      : data.favicon || data.rawFavicon || null;
    const incomingRawFavicon = isEncoded
      ? decodePageMetadata(data.rawFavicon)
      : data.rawFavicon || data.favicon || null;
    const incomingHistory =
      data.history && typeof data.history === "object" ? data.history : null;
    const incomingHistoryLength =
      typeof data.historyLength === "number"
        ? data.historyLength
        : typeof incomingHistory?.length === "number"
          ? incomingHistory.length
          : null;
    const incomingHistoryState =
      "historyState" in data
        ? data.historyState
        : incomingHistory && "state" in incomingHistory
          ? incomingHistory.state
          : null;
    const incomingNavigationType =
      typeof data.navigationType === "string" ? data.navigationType : null;

    const tabs = store.tabs;
    const targetTabId = data.tabId
      ? parseInt(data.tabId as string, 10)
      : null;
    let targetTab: Tab | null = null;
    const sourceTab = event.source
      ? tabs.find((tab) => tab.iframe?.contentWindow === event.source) || null
      : null;

    if (targetTabId) {
      targetTab = tabs.find((tab) => tab.id === targetTabId) || null;
      if (sourceTab && targetTab && sourceTab.id !== targetTab.id) return;
      if (targetTab && data.clientId)
        clientTabMap.set(data.clientId as string, targetTab.id);
    }
    if (!targetTab && sourceTab) {
      targetTab = sourceTab;
      if (data.clientId)
        clientTabMap.set(data.clientId as string, sourceTab.id);
    }
    if (
      !targetTab &&
      data.clientId &&
      clientTabMap.has(data.clientId as string)
    ) {
      const mappedId = clientTabMap.get(data.clientId as string);
      targetTab = tabs.find((tab) => tab.id === mappedId) || null;
    }
    if (!targetTab) return;
    if (
      targetTab.extensionPage &&
      typeof incomingDecodedUrl === "string" &&
      /^https?:\/\//i.test(incomingDecodedUrl)
    ) {
      clearExtensionPageForNavigation(targetTab.iframe, targetTab);
    }
    if (data.isTopFrame === false) return;
    if (
      data.navigationVersion !== undefined &&
      data.navigationVersion !== targetTab.iframe.dataset.navigationVersion
    )
      return;
    if (
      incomingUrl &&
      targetTab.historyManager &&
      (data.source === "folio" || !historyEntry(targetTab.iframe))
    ) {
      targetTab.historyManager.observe(
        incomingUrl,
        incomingNavigationType ?? "metadata",
        data.historyKey,
      );
    }
    if (incomingUrl && !targetTab.isUrlLoaded) {
      targetTab.isUrlLoaded = true;
      if (targetTab.id === store.activeTabId) {
        document.body.classList.add("browser-view");
      }
    }

    if (typeof incomingTitle === "string" && !targetTab.fixedTitle) {
      if (incomingTitle.trim() !== "") targetTab.title = incomingTitle;
    }
    if (data.memory && typeof data.memory.usedJSHeapSize === "number") {
      tabMemory.set(targetTab.id, data.memory);
    }

    const faviconUrl = incomingFavicon ?? incomingRawFavicon ?? null;
    if (faviconUrl && !targetTab.fixedFavicon) {
      targetTab.favicon = faviconUrl.startsWith("/!!/")
        ? faviconUrl
        : getProxyUrl(faviconUrl);
    }
    targetTab.pageState = {
      url: incomingUrl || incomingDecodedUrl || null,
      title: targetTab.title,
      favicon: targetTab.favicon,
      historyLength: incomingHistoryLength,
      historyState: incomingHistoryState,
      navigationType: incomingNavigationType,
      updatedAt: Date.now(),
    };
    if (
      typeof targetTab.pageState.url === "string" &&
      /^https?:\/\//i.test(targetTab.pageState.url)
    ) {
      targetTab.iframe.dataset.manualUrl = targetTab.pageState.url;
    }

    store.notify();
    getRivet()?.notifyTabUpdated(targetTab.id, {
      ...(targetTab.pageState.url ? { url: targetTab.pageState.url } : {}),
      title: targetTab.title,
      favIconUrl: targetTab.favicon ?? "",
    });

    if (targetTab.historyManager) {
      updateHistoryUI(targetTab as never, {
        currentUrl:
          targetTab.pageState.url || targetTab.historyManager.getCurrentUrl(),
        canGoBack: targetTab.historyManager.canGoBack(),
        canGoForward: targetTab.historyManager.canGoForward(),
      });
    }
    return;
  }
  if (data && data.type === "url-update" && data.url) {
    const target = store.tabs.find(
      (tab) =>
        event.source === tab.iframe.contentWindow ||
        (data.tabId && tab.id === Number(data.tabId)),
    );
    if (target)
      handleServiceWorkerMessage({
        data: { ...data, type: "page-meta", tabId: target.id },
        source: event.source,
      } as MessageEvent);
  }
}
