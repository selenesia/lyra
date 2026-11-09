import {
  Rivet,
  createRivetContentScriptPlugin,
  findMatchingCommand,
  triggerCommand,
  buildExtensionUrl,
  extensionPageReloadTarget,
  isMountedExtensionDocument,
  type FolioManagedPluginConstructor,
  type RivetContextMenuRequest,
  type RivetHostBindings,
  type TabInfo,
} from "../../../packages/rivet/src/index";
import type {
  WebRequestDetails,
  WebRequestEventName,
  WebRequestHeader,
} from "../../../packages/rivet/src/registry";
import { navigateIframeTo } from "../browser/iframe";
import { updateHistoryUI } from "../browser/historyUI";
import { store } from "../../state/store";
import { toast } from "../ui/toast";
import { registerRivetBridge } from "./rivetBridge.ts";
import { applyRivetAppearance } from "./rivetAppearance.ts";
import {
  ensureUblockOrigin,
  isStartingUblock,
  UBLOCK_FILTERING_READY_EVENT,
} from "./rivetUblock.ts";
import { resolveRivetDns } from "./rivetDns.ts";
import { NEGATIVE, negativeMessage } from "../runtime/messages.ts";

type LyraTab = (typeof store.tabs)[number];

export type RivetFacade = Rivet;

let instance: RivetFacade | null = null;
let ready: Promise<RivetFacade> | null = null;
interface UblockFiltering {
  waitUntilReady(): Promise<boolean>;
}

let ublockFiltering: UblockFiltering | null = null;
const UBLOCK_FILTERING_TIMEOUT_MS = 30_000;
const UBLOCK_STARTUP_RESPONSE_TIMEOUT_MS = 1_500;
let commandListenerInstalled = false;
let contextMenuElement: HTMLDivElement | null = null;
const extensionPageMountVersions = new WeakMap<HTMLIFrameElement, number>();
const extensionPageRouteListeners = new WeakMap<
  HTMLIFrameElement,
  { listener: () => void; win: Window }
>();

function closeRivetContextMenu(): void {
  contextMenuElement?.remove();
  contextMenuElement = null;
}

function showRivetContextMenu(request: RivetContextMenuRequest): void {
  closeRivetContextMenu();
  const tab = store.tabs.find((candidate) => candidate.id === request.tabId);
  if (!tab) return;

  const frameRect = tab.iframe.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "rivet-context-menu";
  menu.setAttribute("role", "menu");
  for (const item of request.items) {
    if (item.type === "separator") {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = !item.enabled;
    button.setAttribute(
      "role",
      item.type === "normal" ? "menuitem" : "menuitemcheckbox",
    );
    if (item.type !== "normal")
      button.setAttribute("aria-checked", String(item.checked));
    button.textContent = `${item.type !== "normal" ? (item.checked ? "✓ " : "  ") : ""}${item.title}`;
    button.addEventListener("click", () => {
      instance?.triggerContextMenu(
        item.extId,
        item.id,
        request.tabId,
        request.info,
      );
      closeRivetContextMenu();
    });
    menu.appendChild(button);
  }

  menu.style.left = `${frameRect.left + request.clientX}px`;
  menu.style.top = `${frameRect.top + request.clientY}px`;
  document.body.appendChild(menu);
  const bounds = menu.getBoundingClientRect();
  if (bounds.right > window.innerWidth - 8)
    menu.style.left = `${Math.max(8, window.innerWidth - bounds.width - 8)}px`;
  if (bounds.bottom > window.innerHeight - 8)
    menu.style.top = `${Math.max(8, window.innerHeight - bounds.height - 8)}px`;
  contextMenuElement = menu;

  setTimeout(() => {
    window.addEventListener("pointerdown", closeRivetContextMenu, {
      once: true,
    });
  }, 0);
}

function tabUrl(tab: LyraTab): string {
  return (
    tab.pageState?.url ||
    tab.iframe?.dataset.manualUrl ||
    tab.extensionPage?.url ||
    tab.historyManager?.getCurrentUrl?.() ||
    "about:blank"
  );
}

function toTabInfo(tab: LyraTab): TabInfo {
  return {
    id: tab.id,
    windowId: 1,
    url: tabUrl(tab),
    title: tab.title || "untitled",
    active: store.activeTabId === tab.id,
    favIconUrl: tab.favicon ?? "",
    status: tab.isLoading ? "loading" : "complete",
  };
}

function tabForWindow(win: Window): LyraTab | null {
  for (const tab of store.tabs) {
    const top = tab.iframe?.contentWindow;
    if (!top) continue;
    if (top === win) return tab;
    try {
      if (win.top === top) return tab;
    } catch {}
  }
  return null;
}

function openExtensionPage(
  extId: string,
  page: string,
  requestedTabId: number | null,
): void {
  const rivet = instance;
  if (!rivet) return;

  let tab =
    requestedTabId === null
      ? null
      : (store.tabs.find((candidate) => candidate.id === requestedTabId) ??
        null);
  if (!tab) tab = store.getReusableActiveTab();
  if (!tab) {
    tab = store.addTab(null, "extension", false, null, {
      applyNewTabOverride: false,
    });
  }

  tab.isUrlLoaded = true;
  tab.isGame = false;
  tab.fixedTitle = true;
  tab.title = rivet.registry.get(extId)?.manifest.name || "extension";
  delete tab.pageState;
  document.body.classList.add("browser-view");
  store.switchTab(tab.id);

  const frame = tab.iframe;
  const frameExt = frame as HTMLIFrameElement & Record<string, unknown>;
  const previousCleanup = frameExt.__rivetExtensionPageCleanup;
  if (typeof previousCleanup === "function") previousCleanup();
  const previousRouteListener = extensionPageRouteListeners.get(frame);
  if (previousRouteListener) {
    previousRouteListener.win.removeEventListener(
      "hashchange",
      previousRouteListener.listener,
    );
    previousRouteListener.win.removeEventListener(
      "popstate",
      previousRouteListener.listener,
    );
    extensionPageRouteListeners.delete(frame);
  }
  const mountVersion = (extensionPageMountVersions.get(frame) ?? 0) + 1;
  extensionPageMountVersions.set(frame, mountVersion);
  let activePage = page;

  const updatePageState = (nextPage: string, isLoading = true) => {
    activePage = nextPage;
    const extensionUrl = buildExtensionUrl(extId, nextPage);
    tab.extensionPage = { extId, page: nextPage, url: extensionUrl };
    frame.dataset.manualUrl = extensionUrl;
    if (isLoading) store.showLoading(tab.id);
    rivet.notifyTabUpdated(tab.id, {
      status: isLoading ? "loading" : "complete",
      url: extensionUrl,
    });
    store.notify();
    if (store.activeTabId === tab.id) {
      updateHistoryUI(tab as never, {
        currentUrl: extensionUrl,
        canGoBack: tab.historyManager.canGoBack(),
        canGoForward: tab.historyManager.canGoForward(),
      });
    }
  };

  const recoverReload = () => {
    if (extensionPageMountVersions.get(frame) !== mountVersion) return;
    if (
      tab.extensionPage?.extId !== extId ||
      tab.extensionPage.page !== activePage
    )
      return;
    if (isMountedExtensionDocument(frame.contentDocument)) return;

    const targetPage = extensionPageReloadTarget(
      activePage,
      frame.contentWindow?.location.href ?? "",
      location.origin,
      extId,
    );
    if (!targetPage) return;
    frame.style.visibility = "hidden";
    void mountPage(targetPage, true);
  };

  const cleanupMount = () => {
    if (extensionPageMountVersions.get(frame) === mountVersion) {
      extensionPageMountVersions.set(frame, mountVersion + 1);
    }
    const routeListener = extensionPageRouteListeners.get(frame);
    if (routeListener) {
      routeListener.win.removeEventListener(
        "hashchange",
        routeListener.listener,
      );
      routeListener.win.removeEventListener("popstate", routeListener.listener);
      extensionPageRouteListeners.delete(frame);
    }
    frame.removeEventListener("load", recoverReload);
    rivet.unmountExtensionPage(frame);
    frame.style.visibility = "";
    if (frameExt.__rivetExtensionPageCleanup === cleanupMount) {
      delete frameExt.__rivetExtensionPageCleanup;
    }
  };
  frameExt.__rivetExtensionPageCleanup = cleanupMount;
  frame.addEventListener("load", recoverReload);

  const syncPageRoute = () => {
    if (extensionPageMountVersions.get(frame) !== mountVersion) return;
    if (tab.extensionPage?.extId !== extId) return;
    const targetPage = extensionPageReloadTarget(
      activePage,
      frame.contentWindow?.location.href ?? "",
      location.origin,
      extId,
    );
    if (targetPage && targetPage !== activePage)
      updatePageState(targetPage, false);
  };

  const installRouteListener = () => {
    const win = frame.contentWindow;
    if (!win) return;
    const previous = extensionPageRouteListeners.get(frame);
    if (previous) {
      previous.win.removeEventListener("hashchange", previous.listener);
      previous.win.removeEventListener("popstate", previous.listener);
    }
    win.addEventListener("hashchange", syncPageRoute);
    win.addEventListener("popstate", syncPageRoute);
    extensionPageRouteListeners.set(frame, { listener: syncPageRoute, win });
    syncPageRoute();
  };

  const mountPage = async (targetPage: string, recovering = false) => {
    updatePageState(targetPage);
    const mounted = await rivet.mountExtensionPage(
      frame,
      extId,
      targetPage,
      tab.id,
    );
    if (extensionPageMountVersions.get(frame) !== mountVersion) return;
    if (
      tab.extensionPage?.extId !== extId ||
      tab.extensionPage.page !== targetPage
    ) {
      if (recovering) frame.style.visibility = "";
      return;
    }
    if (!mounted) {
      frame.style.visibility = "";
      store.hideLoading(tab.id);
      console.error(
        "[rivet] extension page not found:",
        { extId, targetPage },
        NEGATIVE,
      );
      rivet.notifyTabUpdated(tab.id, { status: "complete" });
      return;
    }
    if (frame.contentDocument) applyRivetAppearance(frame.contentDocument);
    installRouteListener();
    store.hideLoading(tab.id);
    rivet.notifyTabUpdated(tab.id, {
      status: "complete",
      url: tab.extensionPage?.url,
      title: tab.title,
      favIconUrl: tab.favicon ?? "",
    });

    if (recovering)
      requestAnimationFrame(() => {
        if (extensionPageMountVersions.get(frame) === mountVersion)
          frame.style.visibility = "";
      });
  };

  void mountPage(page);
}

function createHostBindings(): RivetHostBindings {
  return {
    resolveDns: resolveRivetDns,
    extensionResponseTimeoutMs: (extId) =>
      instance && isStartingUblock(instance, extId)
        ? UBLOCK_STARTUP_RESPONSE_TIMEOUT_MS
        : undefined,
    getTabId: (win) => tabForWindow(win)?.id ?? null,
    getTab: (tabId) => {
      const tab = store.tabs.find((candidate) => candidate.id === tabId);
      return tab ? toTabInfo(tab) : null;
    },
    getAllTabs: () => store.tabs.map(toTabInfo),
    getActiveTabId: () => store.activeTabId,
    getTabWindow: (tabId) =>
      store.tabs.find((candidate) => candidate.id === tabId)?.iframe
        ?.contentWindow ?? null,
    navigateTab: (tabId, url) => {
      if (tabId === null) {
        const reusableTab = store.getReusableActiveTab();
        if (reusableTab) {
          reusableTab.isUrlLoaded = true;
          reusableTab.isGame = false;
          reusableTab.fixedTitle = false;
          reusableTab.fixedFavicon = false;
          delete reusableTab.extensionPage;
          delete reusableTab.pageState;
          document.body.classList.add("browser-view");
          navigateIframeTo(reusableTab.iframe, url);
          store.updateIframeView();
          return;
        }
        store.addTab(url, "fetching data...");
        return;
      }
      const tab = store.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.iframe) {
        if (tab.extensionPage) {
          delete tab.extensionPage;
          tab.fixedTitle = false;
          delete tab.iframe.dataset.manualUrl;
        }
        navigateIframeTo(tab.iframe, url);
      }
    },
    activateTab: (tabId) => store.switchTab(tabId),
    closeTab: (tabId) => {
      closeRivetContextMenu();
      store.closeTab(tabId);
    },
    openExtensionTab: openExtensionPage,
    closeExtensionPopup: (extId) => {
      window.dispatchEvent(
        new CustomEvent("rivet-close-extension-popup", { detail: { extId } }),
      );
    },
    showNotification: (title, message) => {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body: message });
        return;
      }
      toast.info(
        `${title}${message ? ` — ${message}` : ""}`,
        "IconCircleInfo",
        5000,
      );
    },
    showContextMenu: showRivetContextMenu,
  };
}

function ensureBackgroundRoot(): HTMLElement {
  const existing = document.getElementById("rivet-backgrounds");
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = "rivet-backgrounds";
  root.hidden = true;
  document.body.appendChild(root);
  return root;
}

function installCommandListener(rivet: Rivet): void {
  if (commandListenerInstalled) return;
  commandListenerInstalled = true;
  window.addEventListener("keydown", (event) => {
    const command = findMatchingCommand(rivet.registry, event);
    if (!command) return;
    event.preventDefault();
    triggerCommand(rivet.registry, command.extId, command.name);
  });
}

async function mountNewTabOverride(
  rivet: Rivet,
  tab: LyraTab,
  extId: string,
  page: string,
): Promise<void> {
  try {
    const mounted = await rivet.mountNewTabPage(
      tab.iframe,
      extId,
      page,
      tab.id,
    );
    if (!mounted) {
      console.error(
        "[rivet] new-tab override not found:",
        { extId, page },
        NEGATIVE,
      );
      return;
    }
    if (!store.tabs.includes(tab) || tab.isUrlLoaded) return;
    if (tab.iframe.contentDocument) {
      applyRivetAppearance(tab.iframe.contentDocument);
    }
    tab.isUrlLoaded = true;
    if (store.activeTabId === tab.id) {
      document.body.classList.add("browser-view");
    }
    store.updateIframeView();
  } catch (error) {
    console.error(
      "[rivet] failed to mount new-tab override:",
      { extId, page, error },
      NEGATIVE,
    );
  }
}

function waitForUblockFiltering(rivet: Rivet): UblockFiltering {
  let install: Promise<string | null> | null = null;
  const startInstall = () =>
    (install ??= ensureUblockOrigin(rivet).catch((error) => {
      console.error("[rivet] failed to install ublock origin:", error, NEGATIVE);
      return null;
    }));
  void startInstall();
  let pending: Promise<boolean> | null = null;
  let filteringReady = false;
  return {
    waitUntilReady() {
      if (filteringReady) return Promise.resolve(true);
      return (pending ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        try {
          const listening = await Promise.race([
            startInstall().then((extId) => {
              if (extId === null) {
                install = null;
                return false;
              }
              return rivet.registry.waitForWebRequestListener(
                extId,
                UBLOCK_FILTERING_READY_EVENT,
                Math.max(0, UBLOCK_FILTERING_TIMEOUT_MS - (Date.now() - started)),
              );
            }),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), UBLOCK_FILTERING_TIMEOUT_MS);
            }),
          ]);
          filteringReady = listening;
          if (!listening)
            console.warn("[rivet] content filtering is unavailable", NEGATIVE);
          return listening;
        } finally {
          clearTimeout(timer);
          pending = null;
        }
      })());
    },
  };
}

export async function initializeRivet(): Promise<RivetFacade> {
  if (ready) return ready;
  let created: RivetFacade | null = null;
  const pending = (async () => {
    const rivet = new Rivet({
      host: createHostBindings(),
      backgroundRoot: ensureBackgroundRoot(),
    }) as RivetFacade;
    created = rivet;
    instance = rivet;
    await rivet.init();
    ublockFiltering = waitForUblockFiltering(rivet);
    installCommandListener(rivet);
    registerRivetBridge(rivet, (tab) =>
      mountRivetNewTabOverride(tab as LyraTab),
    );

    const lyra = (window.Lyra ??= {} as typeof window.Lyra);
    (lyra as typeof lyra & { rivet: RivetFacade }).rivet = rivet;
    window.dispatchEvent(new CustomEvent("rivet-ready", { detail: rivet }));
    return rivet;
  })();
  ready = pending;
  try {
    return await pending;
  } catch (error) {
    if (ready === pending) ready = null;
    if (instance === created) instance = null;
    ensureBackgroundRoot().replaceChildren();
    throw error;
  }
}

function applyHeaderChanges(
  rawHeaders: HeadersInit | undefined,
  changes: unknown[],
): [string, string][] {
  const headers = new Headers(rawHeaders);
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const record = change as {
      header?: unknown;
      operation?: unknown;
      value?: unknown;
    };
    if (typeof record.header !== "string") continue;
    const operation = String(record.operation || "set").toLowerCase();
    if (operation === "remove") headers.delete(record.header);
    else if (operation === "append" && typeof record.value === "string") {
      headers.append(record.header, record.value);
    } else if (typeof record.value === "string") {
      headers.set(record.header, record.value);
    }
  }
  return [...headers.entries()];
}

function toWebRequestHeaders(
  rawHeaders: HeadersInit | undefined,
): WebRequestHeader[] {
  return [...new Headers(rawHeaders).entries()].map(([name, value]) => ({
    name,
    value,
  }));
}

function fromWebRequestHeaders(
  headers: WebRequestHeader[],
): [string, string][] {
  return headers.flatMap((header) =>
    typeof header.name === "string" && typeof header.value === "string"
      ? [[header.name, header.value] as [string, string]]
      : [],
  );
}

function webRequestType(parsed: any): string {
  const destination = String(parsed?.destination || "");
  if (destination === "document")
    return parsed?.isIframe ? "sub_frame" : "main_frame";
  if (destination === "iframe" || destination === "frame") return "sub_frame";
  if (destination === "style") return "stylesheet";
  if (destination === "script") return "script";
  if (destination === "image") return "image";
  if (destination === "font") return "font";
  if (
    destination === "audio" ||
    destination === "video" ||
    destination === "track"
  )
    return "media";
  if (
    destination === "worker" ||
    destination === "sharedworker" ||
    destination === "serviceworker"
  )
    return "other";
  if (destination === "report") return "ping";
  if (parsed?.fetchMode) return "xmlhttprequest";
  return "other";
}

function createDnrPlugin(
  ManagedPlugin: FolioManagedPluginConstructor,
  rivet: Rivet,
  tabId: number,
  filtering?: UblockFiltering | null,
): InstanceType<FolioManagedPluginConstructor> {
  const folio = (
    window as typeof window & {
      $folio?: {
        BareResponse?: { fromNativeResponse(response: Response): unknown };
      };
    }
  ).$folio;
  let nextRequestId = 0;
  const requestIds = new WeakMap<object, string>();

  const requestIdFor = (request: object | undefined): string => {
    if (!request) return `rivet-${tabId}-${++nextRequestId}`;
    const existing = requestIds.get(request);
    if (existing) return existing;
    const requestId = `rivet-${tabId}-${++nextRequestId}`;
    requestIds.set(request, requestId);
    return requestId;
  };

  const detailsFor = (
    context: any,
    url: string,
    requestHeaders?: WebRequestHeader[],
    responseHeaders?: WebRequestHeader[],
  ): WebRequestDetails => {
    const parsed = context.parsed;
    const documentUrl =
      parsed?.clientUrl?.href || parsed?.referrerSourceUrl?.href;
    const initiator = parsed?.fetchInitiatorOrigin || parsed?.clientUrl?.origin;
    const frameId = parsed?.isIframe ? 1 : 0;
    return {
      requestId: requestIdFor(context.request),
      url,
      method: String(context.request?.method || "GET"),
      tabId,
      windowId: 1,
      frameId,
      parentFrameId: frameId === 0 ? -1 : 0,
      type: webRequestType(parsed),
      timeStamp: Date.now(),
      ...(initiator ? { initiator, originUrl: initiator } : {}),
      ...(documentUrl ? { documentUrl } : {}),
      ...(requestHeaders ? { requestHeaders } : {}),
      ...(responseHeaders ? { responseHeaders } : {}),
    };
  };

  const dispatch = (event: WebRequestEventName, details: WebRequestDetails) =>
    rivet.registry.dispatchWebRequest(event, details);

  const blockedResponse = () =>
    folio?.BareResponse?.fromNativeResponse(
      new Response(null, { status: 204 }),
    );

  const redirectResponse = (url: string) =>
    folio?.BareResponse?.fromNativeResponse(
      new Response(null, { status: 302, headers: { Location: url } }),
    );

  const filteringUnavailableResponse = () =>
    folio?.BareResponse?.fromNativeResponse(
      new Response(
        negativeMessage("content filtering is unavailable. reload this page"),
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      ),
    );

  let filteringSettled = !filtering;
  const untilFilteringReady = async (): Promise<boolean> => {
    if (filteringSettled) return true;
    filteringSettled = await filtering!.waitUntilReady();
    return filteringSettled;
  };
  const deferredDocuments = new WeakMap<object, WebRequestHeader[]>();

  const deferredDocumentResponse = async (
    context: any,
    requestUrl: string,
    requestHeaders: WebRequestHeader[],
  ): Promise<unknown> => {
    const details = detailsFor(context, requestUrl, requestHeaders);
    for (const event of ["onBeforeRequest", "onBeforeSendHeaders"] as const) {
      if (!rivet.registry.hasWebRequestListeners(event)) continue;
      const result = await dispatch(event, details);
      if (result?.cancel) return blockedResponse();
      if (event === "onBeforeRequest" && result?.redirectUrl)
        return redirectResponse(new URL(result.redirectUrl, requestUrl).href);
    }
    if (rivet.registry.hasWebRequestListeners("onSendHeaders"))
      void dispatch("onSendHeaders", details).catch((error) => {
        console.error("[rivet] send-headers dispatch failed:", error, NEGATIVE);
      });
    const decision = rivet.checkDeclarativeNetRequest(
      requestUrl,
      details.initiator,
      details.type,
    );
    if (decision?.action === "block") return blockedResponse();
    if (decision?.action === "redirect")
      return redirectResponse(new URL(decision.url, requestUrl).href);
    return undefined;
  };

  return new (class RivetDeclarativeNetRequestPlugin extends ManagedPlugin {
    override install(frame: any): void {
      super.install(frame);
      this.tap(frame.hooks.fetch.request, async (context: any, props: any) => {
        let requestUrl = props.url?.href;
        if (!requestUrl) return;
        if (!filteringSettled) {
          if (
            context.request &&
            webRequestType(context.parsed) === "main_frame"
          ) {
            deferredDocuments.set(
              context.request,
              toWebRequestHeaders(props.init?.headers),
            );
            return;
          }
          if (!(await untilFilteringReady())) {
            props.earlyResponse = filteringUnavailableResponse();
            return;
          }
        }
        const beforeRequestListeners =
          rivet.registry.hasWebRequestListeners("onBeforeRequest");
        const beforeHeadersListeners = rivet.registry.hasWebRequestListeners(
          "onBeforeSendHeaders",
        );
        const sendHeadersListeners =
          rivet.registry.hasWebRequestListeners("onSendHeaders");
        if (
          !beforeRequestListeners &&
          !beforeHeadersListeners &&
          !sendHeadersListeners &&
          !rivet.hasDeclarativeNetRequestRules()
        )
          return;
        let requestHeaders =
          beforeRequestListeners ||
          beforeHeadersListeners ||
          sendHeadersListeners
            ? toWebRequestHeaders(props.init?.headers)
            : undefined;
        const details = detailsFor(context, requestUrl, requestHeaders);

        const beforeRequest = beforeRequestListeners
          ? await dispatch("onBeforeRequest", details)
          : null;
        if (beforeRequest?.cancel) {
          props.earlyResponse = blockedResponse();
          return;
        }
        if (beforeRequest?.redirectUrl) {
          props.url = new URL(beforeRequest.redirectUrl, requestUrl);
          requestUrl = props.url.href;
          details.url = requestUrl;
        }

        const beforeHeaders = rivet.registry.hasWebRequestListeners(
          "onBeforeSendHeaders",
        )
          ? await dispatch("onBeforeSendHeaders", details)
          : null;
        if (beforeHeaders?.cancel) {
          props.earlyResponse = blockedResponse();
          return;
        }
        if (beforeHeaders?.requestHeaders) {
          requestHeaders = beforeHeaders.requestHeaders;
          props.init.headers = fromWebRequestHeaders(requestHeaders);
          details.requestHeaders = requestHeaders;
        }
        if (rivet.registry.hasWebRequestListeners("onSendHeaders"))
          void dispatch("onSendHeaders", details).catch((error) => {
            console.error(
              "[rivet] send-headers dispatch failed:",
              error,
              NEGATIVE,
            );
          });

        const decision = rivet.checkDeclarativeNetRequest(
          requestUrl,
          details.initiator,
          details.type,
        );
        if (!decision) return;

        if (decision.action === "block") {
          props.earlyResponse = blockedResponse();
        } else if (decision.action === "redirect") {
          props.url = new URL(decision.url, requestUrl);
        } else if (decision.headers.length) {
          props.init.headers = applyHeaderChanges(
            props.init?.headers,
            decision.headers,
          );
        }
      });

      this.tap(
        frame.hooks.fetch.preresponse,
        async (context: any, props: any) => {
          const requestUrl = context.parsed?.url?.href;
          if (!requestUrl) return;
          const deferredHeaders = context.request
            ? deferredDocuments.get(context.request)
            : undefined;
          if (deferredHeaders) {
            deferredDocuments.delete(context.request);
            if (!(await untilFilteringReady())) {
              props.response = filteringUnavailableResponse();
              return;
            }
            const replacement = await deferredDocumentResponse(
              context,
              requestUrl,
              deferredHeaders,
            );
            if (replacement) {
              props.response = replacement;
              return;
            }
          }
          const receivedListeners =
            rivet.registry.hasWebRequestListeners("onHeadersReceived");
          const completedListeners =
            rivet.registry.hasWebRequestListeners("onCompleted");
          if (
            !receivedListeners &&
            !completedListeners &&
            !rivet.hasDeclarativeNetRequestRules(true)
          )
            return;
          let responseHeaders =
            receivedListeners || completedListeners
              ? toWebRequestHeaders(props.response.rawHeaders)
              : undefined;
          const details = detailsFor(
            context,
            requestUrl,
            undefined,
            responseHeaders,
          );
          details.statusCode = Number(props.response.status) || 0;
          details.statusLine =
            `${details.statusCode} ${props.response.statusText || ""}`.trim();

          const received = receivedListeners
            ? await dispatch("onHeadersReceived", details)
            : null;
          if (received?.cancel) {
            const blocked = blockedResponse();
            if (blocked) props.response = blocked;
            return;
          }
          if (received?.responseHeaders) {
            responseHeaders = received.responseHeaders;
            props.response.rawHeaders = fromWebRequestHeaders(responseHeaders);
            details.responseHeaders = responseHeaders;
          }
          if (received?.redirectUrl) {
            const redirected = redirectResponse(received.redirectUrl);
            if (redirected) props.response = redirected;
            details.redirectUrl = received.redirectUrl;
            if (rivet.registry.hasWebRequestListeners("onBeforeRedirect"))
              void dispatch("onBeforeRedirect", details).catch((error) => {
                console.error(
                  "[rivet] redirect dispatch failed:",
                  error,
                  NEGATIVE,
                );
              });
            return;
          }

          const decision = rivet.checkDeclarativeNetRequest(
            requestUrl,
            details.initiator,
            details.type,
            true,
          );
          if (
            decision?.action === "modifyHeaders" &&
            decision.responseHeaders.length
          ) {
            props.response.rawHeaders = applyHeaderChanges(
              props.response.rawHeaders,
              decision.responseHeaders,
            );
            if (rivet.registry.hasWebRequestListeners("onCompleted"))
              details.responseHeaders = toWebRequestHeaders(
                props.response.rawHeaders,
              );
          }
          if (rivet.registry.hasWebRequestListeners("onCompleted"))
            void dispatch("onCompleted", details).catch((error) => {
              console.error(
                "[rivet] completion dispatch failed:",
                error,
                NEGATIVE,
              );
            });
        },
      );
    }
  })("rivet-declarative-net-request", []);
}

export function createRivetFramePlugins(
  ManagedPlugin: FolioManagedPluginConstructor | undefined,
  iframe: HTMLIFrameElement,
): unknown[] {
  const rivet = instance;
  const tabId = Number(iframe.dataset.tabId);
  if (!rivet || !ManagedPlugin || !Number.isFinite(tabId)) return [];
  return [
    createRivetContentScriptPlugin(ManagedPlugin, rivet, tabId),
    createDnrPlugin(ManagedPlugin, rivet, tabId, ublockFiltering),
  ];
}

function mountRivetNewTabOverride(tab: LyraTab): boolean {
  const rivet = instance;
  const override = rivet?.getNewTabOverride();
  if (!rivet || !override) return false;
  void mountNewTabOverride(rivet, tab, override.extId, override.page);
  return true;
}
