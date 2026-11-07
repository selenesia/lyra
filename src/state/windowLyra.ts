import {
  handleSearch as performSearch,
  getInternalRouteUrl,
} from "../features/search/search.ts";
import {
  store,
  isPlayerStatus,
  proxyGameFavicon,
  rememberTabGameLabel,
} from "./store.ts";

export function setupWindowLyra() {
  window.Lyra = window.Lyra || {};
  window.Lyra.tabs = store.tabs as any;
  window.Lyra.splitPair = store.splitPair;
  window.Lyra.isLoading = false;
  window.Lyra.allGames ??= [];
  window.Lyra.getActiveTab = () => store.getActiveTab();
  window.Lyra.getActivePageState = () => store.getActivePageState();
  window.Lyra.getTabPageState = (tabId: number) =>
    store.getTabPageState(tabId);
  window.Lyra.setPlayerStatus = (tabId: number, status: string) => {
    if (isPlayerStatus(status)) store.setPlayerStatus(tabId, status);
  };
  window.Lyra.renderTabs = () => store.notify();
  window.Lyra.resetSession = () => store.resetSession();
  window.Lyra.openNewTabFromServiceWorker = (
    url: string | null,
    options: { title?: string; openerTabId?: number } = {},
  ) => {
    if (!url) return null;
    const tab = store.addTab(url, options.title || "fetching data...");
    if (tab && options.openerTabId) tab.openerTabId = options.openerTabId;
    return tab;
  };
  window.Lyra.handleSearch = async (
    query: string,
    gameName?: string,
    gameIcon?: string | null,
  ) => {
    const activeTab = store.getActiveTab();
    if (activeTab) {
      const isStreamingUrl = Boolean(getInternalRouteUrl(query));
      if (gameName && !isStreamingUrl) {
        activeTab.isGame = true;
        activeTab.fixedTitle = true;
        activeTab.title = gameName;
        if (gameIcon) {
          activeTab.fixedFavicon = true;
          activeTab.favicon = proxyGameFavicon(gameIcon);
        } else {
          activeTab.fixedFavicon = false;
        }
        rememberTabGameLabel(activeTab, query, gameName);
        store.notify();
      } else {
        activeTab.isGame = false;
        activeTab.fixedTitle = false;
        if (isStreamingUrl && gameIcon) {
          activeTab.fixedFavicon = true;
          activeTab.favicon = proxyGameFavicon(gameIcon);
        } else {
          activeTab.fixedFavicon = false;
        }
        store.notify();
      }
      await performSearch(query, activeTab as never, gameName);
    }
  };
}
