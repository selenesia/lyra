import { store } from "../../state/store.ts";
import { currentUrlSignal } from "../ui/uiSignals";
import { pageStateUrl, getBestKnownUrl, navigationUrl } from "./iframeUrls.ts";
import { getLoadedGameDisplayLabel } from "../media/gameMetadata.ts";
import { getAnimeDisplayLabel } from "../media/animeMetadata.ts";
import { normalizeGameHistoryUrl } from "../runtime/utils";
import { getStoredGameSource } from "../config/settingsOptions.ts";
import type { LyraTab } from "./iframe.ts";

interface HistoryUIState {
  currentUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

let _searchInputNav: HTMLElement | null = null;
let _backIcon: HTMLElement | null = null;
let _forwardIcon: HTMLElement | null = null;

function getNavEls() {
  if (!_searchInputNav?.isConnected)
    _searchInputNav = document.getElementById(
      "searchInputt",
    );
  if (!_backIcon?.isConnected) _backIcon = document.getElementById("backIcon");
  if (!_forwardIcon?.isConnected)
    _forwardIcon = document.getElementById("forwardIcon");
}

export function updateHistoryUI(
  activeTab: LyraTab,
  { currentUrl, canGoBack, canGoForward }: HistoryUIState,
): void {
  if (activeTab?.id !== store.activeTabId) return;
  getNavEls();
  const stillExists =
    activeTab && window.Lyra?.tabs?.some((tab) => tab.id === activeTab.id);

  if (!activeTab || !activeTab.iframe || !stillExists) {
    if (_searchInputNav) _searchInputNav.textContent = "";
    if (_backIcon) _backIcon.classList.add("disabled");
    if (_forwardIcon) _forwardIcon.classList.add("disabled");
    currentUrlSignal.value = "";
    return;
  }

  const { iframe } = activeTab;

  for (const [element, enabled] of [
    [_backIcon, canGoBack],
    [_forwardIcon, canGoForward],
  ] as const) {
    if (!element) continue;
    element.classList.toggle("disabled", !enabled);
    element.setAttribute("aria-disabled", String(!enabled));
    element.tabIndex = enabled ? 0 : -1;
  }

  if (_searchInputNav) {
    const trackedPageUrl = pageStateUrl(activeTab);
    let displayUrl: string | null | undefined =
      currentUrl ?? trackedPageUrl ?? activeTab.extensionPage?.url;
    if (displayUrl === undefined || displayUrl === null) {
      displayUrl = getBestKnownUrl(iframe, activeTab);
    }

    const decoded = navigationUrl(displayUrl ?? "");
    let displayText: string = decoded;

    if (activeTab.extensionPage && !trackedPageUrl) {
      const title = activeTab.title.trim().toLowerCase() || "extension";
      displayText = `extension: ${title} / ${activeTab.extensionPage.page}`;
    }

    try {
      const custom = getLoadedGameDisplayLabel(decoded);
      if (!activeTab.extensionPage && custom) displayText = custom as string;
    } catch (e) {}

    if (!activeTab.extensionPage && displayText === decoded) {
      const animeLabel = getAnimeDisplayLabel(decoded);
      if (animeLabel) displayText = animeLabel;
    }

    if (
      displayText === decoded &&
      activeTab.gameDisplayByUrl &&
      typeof activeTab.gameDisplayByUrl === "object"
    ) {
      const normalized = normalizeGameHistoryUrl(decoded);
      const remembered = normalized
        ? (activeTab.gameDisplayByUrl as Record<string, string>)[normalized]
        : null;
      if (remembered) displayText = remembered;
    }

    if (displayText === decoded && activeTab.fixedTitle && activeTab.isGame) {
      const rawTitle =
        typeof activeTab.title === "string" ? activeTab.title.trim() : "";
      const safeTitle = rawTitle.toLowerCase();
      if (
        safeTitle &&
        safeTitle !== "fetching data..." &&
        safeTitle !== "new tab"
      ) {
        const source = getStoredGameSource();
        displayText = `game: ${safeTitle} / source: ${source}`;
      }
    }

    if (document.activeElement !== _searchInputNav) {
      _searchInputNav.textContent =
        displayText === "about:blank" || !displayText ? "" : displayText;
    }

    currentUrlSignal.value = decoded || "";
  }
}
