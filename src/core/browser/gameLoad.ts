import { decodeUrl } from "../runtime/utils";
import { hostFromUrl, recordGameMetric } from "../media/gameDiagnostics.ts";
import {
  type GameSourceKey,
  getStoredGameSource,
} from "../config/settingsOptions.ts";
import { isCurrentNavigation } from "./navigationVersion.ts";
import { hideLoading } from "../../state/store.ts";
import type { LyraTab } from "./iframe.ts";

const GAME_LOAD_TIMEOUT_MS = 45_000;

export function syncGlobalLoadingState(): void {
  window.Lyra.isLoading = Boolean(
    window.Lyra.tabs?.some((tab: LyraTab) => tab.isLoading),
  );
}

export function clearGameLoadState(
  iframe: HTMLIFrameElement,
  resetTerminal = false,
): number | null {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  if (resetTerminal) delete iframeExt.__gameLoadTerminal;
  const timeout = iframeExt.__gameLoadTimeout;
  if (timeout) clearTimeout(timeout as ReturnType<typeof setTimeout>);
  iframeExt.__gameLoadTimeout = null;
  const startedAt = iframeExt.__gameLoadStartedAt;
  delete iframeExt.__gameLoadStartedAt;
  return typeof startedAt === "number" ? startedAt : null;
}

export function finishGameLoadMetric(
  iframe: HTMLIFrameElement,
  status: "success" | "error",
  stage: "iframe-load" | "iframe-timeout" = "iframe-load",
): void {
  const startedAt = clearGameLoadState(iframe);
  if (startedAt === null) return;
  const tab = window.Lyra?.tabs?.find(
    (candidate) => candidate.iframe === iframe,
  );
  if (!tab?.isGame) return;
  const realUrl = decodeUrl(iframe.dataset.manualUrl || iframe.src || "");
  const gameHost = hostFromUrl(realUrl);
  const source: GameSourceKey = getStoredGameSource();
  const metric = {
    stage,
    source,
    status,
    durationMs:
      (typeof performance === "undefined" ? Date.now() : performance.now()) -
      startedAt,
  } as const;
  if (gameHost) recordGameMetric({ ...metric, urlHost: gameHost });
  else recordGameMetric(metric);
}

export function armGameLoadTimeout(
  iframe: HTMLIFrameElement,
  version: number,
  tabId: number | null,
): void {
  const tab = window.Lyra?.tabs?.find(
    (candidate) => candidate.iframe === iframe,
  );
  if (!tab?.isGame) return;
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const startedAt =
    typeof performance === "undefined" ? Date.now() : performance.now();
  iframeExt.__gameLoadStartedAt = startedAt;
  iframeExt.__gameLoadTimeout = setTimeout(() => {
    if (!isCurrentNavigation(iframe, version)) return;
    failGameNavigation(iframe, tabId, "iframe-timeout");
  }, GAME_LOAD_TIMEOUT_MS);
}

export function isKnownGameErrorDocument(iframe: HTMLIFrameElement): boolean {
  try {
    const title = iframe.contentDocument?.title?.trim();
    return title === "404!!" || title === "Folio" || title === "Error";
  } catch {
    return false;
  }
}

export function failGameNavigation(
  iframe: HTMLIFrameElement,
  tabId: number | null,
  stage: "iframe-load" | "iframe-timeout" = "iframe-load",
) {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  iframeExt.__gameLoadTerminal = "error";
  finishGameLoadMetric(iframe, "error", stage);
  hideLoading(tabId ?? undefined);
  syncGlobalLoadingState();
  const tab = window.Lyra?.tabs?.find(
    (candidate) => candidate.iframe === iframe,
  );
  if (tab?.isGame) window.Lyra.setPlayerStatus?.(tab.id, "error");
  iframe.parentElement?.classList.add("loaded");
  return tab;
}
