import { EventHub } from "../eventHub";
import { negativeMessage } from "../messages";
import type { ExtensionState, PortRecord } from "../registry";
import { buildExtensionUrl } from "../urlScheme";
import {
  buildTabObject,
  cloneForRealm,
  cloneMessage,
  dispatchMessage,
  originOf,
} from "./common";
import type { ChromeApiContext } from "./context";

let portIdCounter = 0;

export function createRuntimeApis(context: ChromeApiContext) {
  const {
    realm,
    extId,
    tabId,
    registry,
    host,
    ext,
    events,
    isBackground = false,
    senderUrl,
    senderFrameId,
    senderDocumentId,
  } = context;
  let lastError: { message: string } | undefined;
  const canReceive = (
    target: ExtensionState | undefined,
  ): target is ExtensionState => {
    if (!target?.enabled) return false;
    if (target.id === extId || !target.manifest.externally_connectable)
      return true;
    const ids = target.manifest.externally_connectable.ids;
    return Boolean(ids?.includes("*") || ids?.includes(extId));
  };
  const messageHubs = (target: ExtensionState | undefined) => {
    if (!canReceive(target)) return [];
    const event =
      target.id === extId ? "runtimeOnMessage" : "runtimeOnMessageExternal";
    return [target.background?.events, target.popupEvents]
      .filter((recipient) => recipient && recipient !== events)
      .map((recipient) => recipient![event]);
  };

  const waitForBackground = async (targetExt: string) => {
    let target = registry.get(targetExt);
    while (
      target?.enabled &&
      !target.background &&
      target.resolveBackgroundReady
    ) {
      await target.backgroundReady;
      target = registry.get(targetExt);
    }
    return target;
  };

  const runtime = {
    id: extId,
    getManifest: () => cloneForRealm(realm, ext.manifest),
    getURL: (path?: string) =>
      buildExtensionUrl(extId, path == null ? "" : String(path)),
    reload: () => ext.reloadBackground?.(),
    sendMessage: (...args: unknown[]) => {
      const callback =
        typeof args[args.length - 1] === "function"
          ? (args.pop() as (response: unknown) => void)
          : undefined;
      const hasTarget =
        args.length >= 3 ||
        (args.length === 2 && (typeof args[0] === "string" || args[0] == null));
      const targetExt = hasTarget ? String(args[0] || extId) : extId;
      const message = hasTarget ? args[1] : args[0];
      let payload: unknown;
      let serializationFailed = false;
      try {
        payload = cloneMessage(message);
      } catch {
        serializationFailed = true;
      }
      const sender = {
        id: extId,
        url: senderUrl,
        origin: originOf(senderUrl),
        frameId: senderFrameId,
        documentId: senderDocumentId,
        tab: tabId !== null ? buildTabObject(host, tabId, realm) : undefined,
      };
      const send = async () => {
        if (serializationFailed)
          throw new Error(
            negativeMessage("extension message could not be serialized"),
          );
        let target = registry.get(targetExt);
        let hubs = messageHubs(target);
        while (
          !hubs.some((hub) => hub.hasListeners()) &&
          canReceive(target) &&
          !(isBackground && targetExt === extId) &&
          target.background?.events !== events &&
          target.resolveBackgroundReady
        ) {
          await target.backgroundReady;
          target = registry.get(targetExt);
          hubs = messageHubs(target);
        }
        if (!hubs.some((hub) => hub.hasListeners()))
          throw new Error(
            negativeMessage("extension message receiver is unavailable"),
          );
        const response = await dispatchMessage(hubs, payload, sender);
        return response === undefined
          ? undefined
          : cloneForRealm(realm, cloneMessage(response));
      };
      const responsePromise = send();
      if (callback) {
        void responsePromise.then(callback, () => {
          const previous = lastError;
          lastError = { message: negativeMessage("extension message failed") };
          try {
            callback(undefined);
          } finally {
            lastError = previous;
          }
        });
        return undefined;
      }
      return responsePromise;
    },
    onMessage: events.runtimeOnMessage.toApi(),
    onMessageExternal: events.runtimeOnMessageExternal.toApi(),
    onInstalled: events.runtimeOnInstalled.toApi(),
    onStartup: events.runtimeOnStartup.toApi(),
    onConnect: events.runtimeOnConnect.toApi(),
    onConnectExternal: events.runtimeOnConnectExternal.toApi(),
    connect: (extIdOrInfo?: unknown, maybeInfo?: unknown) => {
      const targetExt = typeof extIdOrInfo === "string" ? extIdOrInfo : extId;
      const connectInfo = (
        typeof extIdOrInfo === "string" ? maybeInfo : extIdOrInfo
      ) as { name?: string } | undefined;
      const name = connectInfo?.name ?? "";
      const portId = `port_${++portIdCounter}`;

      const callerSide = {
        onMessage: new EventHub(),
        onDisconnect: new EventHub(),
      };
      const remoteSide = {
        onMessage: new EventHub(),
        onDisconnect: new EventHub(),
      };

      const sender = {
        id: extId,
        url: senderUrl,
        origin: originOf(senderUrl),
        frameId: senderFrameId,
        documentId: senderDocumentId,
        tab: tabId !== null ? buildTabObject(host, tabId, realm) : undefined,
      };
      let callerPort: typeof remotePort;
      let remotePort: {
        name: string;
        sender: typeof sender;
        postMessage: (message: unknown) => void;
        disconnect: () => void;
        onMessage: ReturnType<EventHub["toApi"]>;
        onDisconnect: ReturnType<EventHub["toApi"]>;
      };
      let disconnected = false;
      let connected = false;
      const pendingMessages: unknown[] = [];

      const disconnectFrom = (side: "caller" | "remote") => {
        if (disconnected) return;
        disconnected = true;
        pendingMessages.length = 0;
        ext.ports.delete(portId);
        queueMicrotask(() => {
          if (side === "caller") remoteSide.onDisconnect.fire(remotePort);
          else callerSide.onDisconnect.fire(callerPort);
        });
      };

      callerPort = {
        name,
        sender,
        postMessage: (message: unknown) => {
          if (disconnected)
            throw new Error(negativeMessage("extension port is disconnected"));
          const payload = cloneMessage(message);
          if (!connected) pendingMessages.push(payload);
          else
            queueMicrotask(() => {
              if (!disconnected) remoteSide.onMessage.fire(payload, remotePort);
            });
        },
        disconnect: () => disconnectFrom("caller"),
        onMessage: callerSide.onMessage.toApi(),
        onDisconnect: callerSide.onDisconnect.toApi(),
      };
      remotePort = {
        name,
        sender,
        postMessage: (message: unknown) => {
          if (disconnected)
            throw new Error(negativeMessage("extension port is disconnected"));
          const payload = cloneMessage(message);
          queueMicrotask(() => {
            if (!disconnected)
              callerSide.onMessage.fire(
                cloneForRealm(realm, payload),
                callerPort,
              );
          });
        },
        disconnect: () => disconnectFrom("remote"),
        onMessage: remoteSide.onMessage.toApi(),
        onDisconnect: remoteSide.onDisconnect.toApi(),
      };

      const record: PortRecord = {
        id: portId,
        name,
        extId: targetExt,
        remote: remoteSide,
      };
      ext.ports.set(portId, record);

      const deliver = (target: ExtensionState | undefined) => {
        if (disconnected) return;
        const event =
          targetExt === extId ? "runtimeOnConnect" : "runtimeOnConnectExternal";
        const recipients = canReceive(target)
          ? [target.background?.events, target.popupEvents].filter(
              (recipient) =>
                recipient &&
                recipient !== events &&
                recipient[event].hasListeners(),
            )
          : [];
        if (!recipients.length) {
          disconnectFrom("remote");
          return;
        }
        for (const recipient of recipients) recipient![event].fire(remotePort);
        connected = true;
        for (const payload of pendingMessages) {
          queueMicrotask(() => {
            if (!disconnected) remoteSide.onMessage.fire(payload, remotePort);
          });
        }
        pendingMessages.length = 0;
      };
      const target = registry.get(targetExt);
      if (
        target?.background ||
        !target?.resolveBackgroundReady ||
        !canReceive(target) ||
        (isBackground && targetExt === extId)
      ) {
        deliver(target);
      } else {
        void waitForBackground(targetExt).then((readyTarget) => {
          deliver(readyTarget);
        });
      }

      return callerPort;
    },
    get lastError() {
      return lastError;
    },
    getPlatformInfo: (cb?: (info: unknown) => void) => {
      const result = { os: "linux", arch: "x86-64", nacl_arch: "x86_64" };
      cb?.(result);
      return Promise.resolve(result);
    },
    openOptionsPage: (cb?: () => void) => {
      const page = ext.manifest.options_page ?? ext.manifest.options_ui?.page;
      if (page) host.openExtensionTab?.(extId, page, tabId);
      cb?.();
    },
    setUninstallURL: (_url?: string, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    requestUpdateCheck: (cb?: (status: string, details: unknown) => void) => {
      cb?.("no_update", {});
      return Promise.resolve({ status: "no_update", details: {} });
    },
  };

  const extension = {
    getURL: runtime.getURL,
    getBackgroundPage: () =>
      ext.background?.kind === "frame"
        ? (ext.background.frame?.contentWindow ?? null)
        : null,
    inIncognitoContext: false,
    isAllowedIncognitoAccess: (cb?: (allowed: boolean) => void) => {
      cb?.(false);
      return Promise.resolve(false);
    },
    isAllowedFileSchemeAccess: (cb?: (allowed: boolean) => void) => {
      cb?.(false);
      return Promise.resolve(false);
    },
    onMessage: runtime.onMessage,
    onMessageExternal: runtime.onMessageExternal,
    sendMessage: runtime.sendMessage,
  };

  return { runtime, extension };
}
