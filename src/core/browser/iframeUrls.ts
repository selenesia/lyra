import { appPath } from "../runtime/hosting.ts";
import { decodeUrl } from "../runtime/utils";

interface UrlTrackedTab {
  extensionPage?: { url: string };
  pageState?: { url: string | null };
  historyManager?: { getCurrentUrl(): string | null };
}

export function getTabIdFromIframe(iframe: HTMLIFrameElement): number | null {
  if (!iframe) return null;
  const tabId = iframe.dataset?.tabId;
  if (!tabId) return null;
  const parsedTabId = parseInt(tabId, 10);
  return Number.isNaN(parsedTabId) ? null : parsedTabId;
}

export function pageStateUrl(tab: UrlTrackedTab | null | undefined): string | null {
  const url = tab?.pageState?.url;
  return typeof url === "string" && url && url !== "about:blank" ? url : null;
}

export function getBestKnownUrl(
  iframe: HTMLIFrameElement,
  tab?: UrlTrackedTab | null,
): string | null {
  if (tab?.extensionPage?.url) return tab.extensionPage.url;
  if (tab?.historyManager?.getCurrentUrl?.())
    return tab.historyManager.getCurrentUrl();
  const trackedUrl = pageStateUrl(tab);
  if (trackedUrl) return trackedUrl;
  if (iframe.dataset.manualUrl) return iframe.dataset.manualUrl;
  try {
    const frameUrl = iframe.contentWindow?.location?.href;
    if (frameUrl && frameUrl !== "about:blank") return frameUrl;
  } catch (e) {}
  return iframe.src && iframe.src !== "about:blank" ? iframe.src : null;
}

export function navigationUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (
      parsed.origin === window.location.origin &&
      (parsed.pathname === appPath("/f") || parsed.pathname.startsWith(appPath("/!!/")))
    )
      return decodeUrl(url);
  } catch {}
  return url;
}
