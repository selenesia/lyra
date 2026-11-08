import {
  withBrowserPromiseFallback,
  withMissingMemberFallback,
} from "../autoStub";
import {
  contentScriptScope,
  createContentScriptScope,
} from "../contentScope";
import { NEGATIVE, negativeMessage } from "../messages";
import { installExtensionNetwork } from "../network";
import {
  createRealmEvents,
  type RealmEvents,
  type RivetRegistry,
} from "../registry";
import type { RivetHostBindings } from "../types";
import {
  adoptApiObjectsForRealm,
  generateDocumentId,
  setRealmApi,
  traceCalls,
} from "./common";
import type { ChromeApiContext, ContentScopeInTab } from "./context";
import { createDnsApi } from "./dns";
import { createNetworkApis } from "./network";
import { createPlatformApis } from "./platform";
import { createRuntimeApis } from "./runtime";
import { createScriptingApis } from "./scripting";
import { createStateApis } from "./state";
import { createStorageApi } from "./storage";
import { createTabApis } from "./tabs";
import { createUiApis } from "./ui";

export interface InstallChromeApiOptions {
  extId: string;
  tabId: number | null;
  isBackground: boolean;
  registry: RivetRegistry;
  host: RivetHostBindings;
  skipTabRegistration?: boolean | undefined;
  senderUrl?: string | undefined;
  senderFrameId?: number | undefined;
  senderDocumentId?: string | undefined;
  installNetwork?: boolean;
}

export interface ChromeApiBindings {
  chrome: unknown;
  browser: unknown;
  events: RealmEvents;
}

export function installChromeApi(
  realm: Window,
  options: InstallChromeApiOptions,
): RealmEvents {
  const { chrome, browser, events } = createChromeApi(realm, options);
  setRealmApi(realm, "chrome", chrome);
  if (!setRealmApi(realm, "browser", browser)) {
    console.warn(
      "[rivet] browser api could not be installed in this frame",
      NEGATIVE,
    );
  }
  return events;
}

export function createChromeApi(
  realm: Window,
  options: InstallChromeApiOptions,
): ChromeApiBindings {
  const {
    extId,
    tabId,
    isBackground,
    registry,
    host,
    skipTabRegistration,
    senderUrl,
    senderFrameId,
    senderDocumentId,
    installNetwork = true,
  } = options;
  const ext = registry.get(extId);
  if (!ext) {
    throw new Error(
      negativeMessage("rivet api installation requested an unknown extension"),
    );
  }

  if (installNetwork) {
    installExtensionNetwork(realm, senderUrl, () =>
      host.extensionResponseTimeoutMs?.(extId),
    );
  }
  const events = createRealmEvents();
  const frameId = senderFrameId ?? (tabId === null ? undefined : 0);
  const documentId =
    senderDocumentId ?? (tabId === null ? undefined : generateDocumentId());
  if (isBackground) {
    registry.removeWebRequestListeners(extId);
  } else if (
    tabId !== null &&
    !skipTabRegistration &&
    frameId !== undefined &&
    documentId !== undefined
  ) {
    let documents = ext.tabEvents.get(tabId);
    if (!documents || frameId === 0) {
      documents = new Map();
      ext.tabEvents.set(tabId, documents);
    }
    documents.set(documentId, { documentId, frameId, events });
  }

  const context: ChromeApiContext = {
    realm,
    extId,
    tabId,
    registry,
    host,
    ext,
    events,
    isBackground,
    senderUrl,
    senderFrameId: frameId,
    senderDocumentId: documentId,
  };

  const { runtime, extension } = createRuntimeApis(context);
  const dns = createDnsApi(context);
  const storage = createStorageApi(context);
  const contentScopeInTab: ContentScopeInTab = (targetRealm, targetTabId) => {
    const existing = contentScriptScope(targetRealm, extId);
    if (existing) return existing;
    const { chrome, browser } = createChromeApi(targetRealm, {
      extId,
      tabId: targetTabId,
      isBackground: false,
      registry,
      host,
      senderUrl: host.getTab(targetTabId)?.url,
      senderFrameId: 0,
      senderDocumentId: generateDocumentId(),
    });
    return createContentScriptScope(targetRealm, extId, { chrome, browser });
  };
  const { tabs, windows } = createTabApis(context, contentScopeInTab);
  const {
    i18n,
    identity,
    commands,
    omnibox,
    contentSettings,
    proxy,
    system,
    power,
    management,
    webNavigation,
    tts,
    clipboard,
    fontSettings,
    app,
    csi,
    loadTimes,
  } = createPlatformApis(context);
  const { contextMenus, notifications, action, browserAction, pageAction } =
    createUiApis(context);
  const { cookies, webRequest, declarativeNetRequest } =
    createNetworkApis(context);
  const { contentScripts, scripting, userScripts } = createScriptingApis(
    context,
    contentScopeInTab,
  );
  const { alarms, permissions, history, bookmarks, downloads } =
    createStateApis(context);

  const chromeApi = {
    runtime,
    storage,
    tabs,
    windows,
    extension,
    i18n,
    contextMenus,
    notifications,
    cookies,
    get dns() {
      return ext.grantedPermissions.has("dns") ? dns : undefined;
    },
    webRequest,
    contentScripts,
    declarativeNetRequest,
    scripting,
    userScripts,
    action,
    browserAction,
    pageAction,
    alarms,
    permissions,
    history,
    bookmarks,
    downloads,
    identity,
    commands,
    omnibox,
    contentSettings,
    proxy,
    system,
    power,
    management,
    webNavigation,
    tts,
    clipboard,
    fontSettings,
    app,
    csi,
    loadTimes,
  };

  adoptApiObjectsForRealm(realm, chromeApi);

  const chromeApiWithFallback = (globalThis as { RIVET_TRACE?: boolean })
    .RIVET_TRACE
    ? traceCalls(withMissingMemberFallback(chromeApi))
    : withMissingMemberFallback(chromeApi);
  const browserApiWithFallback = withBrowserPromiseFallback(
    chromeApiWithFallback,
    (realm as unknown as { Promise: PromiseConstructor }).Promise,
  );

  return {
    chrome: chromeApiWithFallback,
    browser: browserApiWithFallback,
    events,
  };
}
