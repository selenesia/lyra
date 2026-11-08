import {
  withBrowserPromiseFallback,
  withMissingMemberFallback,
} from "../autoStub";
import { answerMessage, cloneMessage } from "../chromeApi/common";
import type { ChromeApiContext } from "../chromeApi/context";
import {
  identityRedirectUrl,
  readExtensionMessage,
} from "../chromeApi/platform";
import { createStorageApi } from "../chromeApi/storage";
import { EventHub, type Listener } from "../eventHub";
import { NEGATIVE, negativeMessage } from "../messages";
import type { RealmEvents, RivetRegistry } from "../registry";
import { buildExtensionUrl } from "../urlScheme";
import {
  encodeFunction,
  mapFunctions,
  type ApiShape,
  type FrameToHostMessage,
  type HostToFrameMessage,
  type IsolatedBackgroundInit,
  type IsolatedListenerKind,
} from "./protocol";

interface ListenerHandlers {
  event?: (args: unknown[]) => void;
  request?: (args: unknown[]) => unknown;
  portOpen?: (port: object) => void;
}

interface FramePortRecord {
  receive: (message: unknown) => void;
  close: () => void;
}

interface EventApi {
  addListener: (listener: Listener, ...options: unknown[]) => void;
  removeListener: (listener: Listener) => void;
  hasListener: (listener: Listener) => boolean;
  hasListeners: () => boolean;
}

export interface IsolatedChromeApi {
  chrome: object;
  browser: object;
  responseTimeoutMs: () => number | undefined;
}

function eventKind(path: string[]): IsolatedListenerKind {
  const name = path.join(".");
  if (name === "runtime.onMessage" || name === "runtime.onMessageExternal")
    return "message";
  if (name === "runtime.onConnect" || name === "runtime.onConnectExternal")
    return "connect";
  return path[0] === "webRequest" ? "webRequest" : "event";
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.endsWith(NEGATIVE)
    ? error.message
    : negativeMessage("extension api call failed");
}

export function createIsolatedChromeApi(
  realm: Window,
  port: MessagePort,
  init: IsolatedBackgroundInit,
): IsolatedChromeApi {
  const { extId } = init;
  let nextCallId = 0;
  let nextListenerId = 0;
  let nextFunctionId = 0;
  let nextPortId = 0;
  let responseTimeoutMs = init.responseTimeoutMs;
  let lastError: { message: string } | undefined;
  const pendingCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Map<number, ListenerHandlers>();
  const exportedFunctions = new Map<number, { fn: Listener; sent: number }>();
  const functionIds = new WeakMap<Listener, number>();
  const ports = new Map<string, FramePortRecord>();

  const post = (message: FrameToHostMessage) => port.postMessage(message);

  const exportFunction = (fn: Listener) => {
    let id = functionIds.get(fn);
    let entry = id === undefined ? undefined : exportedFunctions.get(id);
    if (id === undefined || !entry) {
      id = ++nextFunctionId;
      entry = { fn, sent: 0 };
      functionIds.set(fn, id);
      exportedFunctions.set(id, entry);
    }
    entry.sent += 1;
    let source = "";
    try {
      source = Function.prototype.toString.call(fn);
    } catch {}
    return encodeFunction(id, source);
  };

  const request = <T>(send: (id: number) => FrameToHostMessage): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextCallId;
      pendingCalls.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        post(send(id));
      } catch {
        pendingCalls.delete(id);
        reject(
          new Error(
            negativeMessage("extension api arguments could not be sent"),
          ),
        );
      }
    });

  const withLastError = (message: string, run: () => void) => {
    const previous = lastError;
    lastError = { message };
    try {
      run();
    } finally {
      lastError = previous;
    }
  };

  const call = (path: string[], input: unknown[]) => {
    const args = [...input];
    const callback =
      typeof args[args.length - 1] === "function"
        ? (args.pop() as Listener)
        : undefined;
    const result = request((id) => {
      const encoded = mapFunctions(args, exportFunction);
      return {
        type: "call",
        id,
        path,
        args: encoded.value as unknown[],
        functions: encoded.replaced,
      };
    });
    if (!callback) return result;
    result.then(
      (value) => callback(value),
      (error) => withLastError(errorText(error), () => callback()),
    );
    return undefined;
  };

  const subscribe = (
    path: string[],
    kind: IsolatedListenerKind,
    handlers: ListenerHandlers,
    options: unknown[] = [],
  ) => {
    const listener = ++nextListenerId;
    listeners.set(listener, handlers);
    post({
      type: "listen",
      listener,
      path,
      kind,
      options: mapFunctions(options, () => undefined).value as unknown[],
    });
    return listener;
  };

  const unsubscribe = (listener: number) => {
    listeners.delete(listener);
    post({ type: "unlisten", listener });
  };

  const openPort = (id: string, name: string, sender: unknown) => {
    const onMessage = new EventHub();
    const onDisconnect = new EventHub();
    let connected = true;
    const api = {
      name,
      sender,
      postMessage: (message: unknown) => {
        if (!connected)
          throw new Error(negativeMessage("extension port is disconnected"));
        post({ type: "portPost", port: id, message: cloneMessage(message) });
      },
      disconnect: () => {
        if (!connected) return;
        connected = false;
        ports.delete(id);
        post({ type: "portDisconnect", port: id });
      },
      onMessage: onMessage.toApi(),
      onDisconnect: onDisconnect.toApi(),
    };
    ports.set(id, {
      receive: (message) => onMessage.fire(message, api),
      close: () => {
        if (!connected) return;
        connected = false;
        ports.delete(id);
        onDisconnect.fire(api);
      },
    });
    return api;
  };

  const sharedEvent = (
    path: string[],
    kind: Exclude<IsolatedListenerKind, "webRequest">,
    hub = new EventHub(),
  ): EventApi => {
    let subscription = 0;
    const handlers: ListenerHandlers =
      kind === "message"
        ? {
            request: ([message, sender]) =>
              answerMessage(hub.snapshot(), message, sender).then((answer) => {
                if (!answer.answered) return answer;
                try {
                  return {
                    answered: true,
                    response: cloneMessage(answer.response),
                  };
                } catch {
                  return { answered: true, response: undefined };
                }
              }),
          }
        : kind === "connect"
          ? { portOpen: (framePort) => hub.fire(framePort) }
          : { event: (args) => hub.fire(...args) };
    return {
      addListener: (listener) => {
        if (typeof listener !== "function" || hub.hasListener(listener)) return;
        hub.addListener(listener);
        if (!subscription) subscription = subscribe(path, kind, handlers);
      },
      removeListener: (listener) => {
        hub.removeListener(listener);
        if (subscription && !hub.hasListeners()) {
          unsubscribe(subscription);
          subscription = 0;
        }
      },
      hasListener: hub.hasListener,
      hasListeners: hub.hasListeners,
    };
  };

  const webRequestEvent = (path: string[]): EventApi => {
    const subscriptions = new Map<Listener, number>();
    return {
      addListener: (listener, filter, extraInfoSpec) => {
        if (typeof listener !== "function" || subscriptions.has(listener))
          return;
        subscriptions.set(
          listener,
          subscribe(
            path,
            "webRequest",
            {
              event: ([details]) => {
                try {
                  listener(details);
                } catch (error) {
                  console.error(
                    "[rivet] web request listener threw",
                    error,
                    NEGATIVE,
                  );
                }
              },
              request: ([details]) => listener(details),
            },
            [filter ?? {}, extraInfoSpec ?? []],
          ),
        );
      },
      removeListener: (listener) => {
        const subscription = subscriptions.get(listener);
        if (subscription === undefined) return;
        subscriptions.delete(listener);
        unsubscribe(subscription);
      },
      hasListener: (listener) => subscriptions.has(listener),
      hasListeners: () => subscriptions.size > 0,
    };
  };

  const storageHub = new EventHub();
  const storageEvents = {
    storageOnChanged: storageHub,
  } as unknown as RealmEvents;
  let storageForwarding = Promise.resolve();
  const forwardStorageChange = async ([changes, area]: unknown[]) => {
    const listening = await request<boolean>((id) => ({
      type: "storageListening",
      id,
    }));
    if (listening)
      post({ type: "storageChanged", area: String(area), changes });
  };
  const storageRegistry = {
    broadcast: (
      _extId: string,
      pick: (events: RealmEvents) => EventHub,
      args: unknown[],
    ) => {
      pick(storageEvents).fire(...args);
      storageForwarding = storageForwarding
        .then(() => forwardStorageChange(args))
        .catch(() => {});
    },
  } as unknown as RivetRegistry;
  const storage = {
    ...createStorageApi({
      extId,
      realm,
      registry: storageRegistry,
      events: storageEvents,
    } as ChromeApiContext),
    onChanged: sharedEvent(["storage", "onChanged"], "event", storageHub),
  };

  const connect = (...args: unknown[]) => {
    const id = `f${++nextPortId}`;
    const info = (typeof args[0] === "string" ? args[1] : args[0]) as
      { name?: unknown } | undefined;
    const framePort = openPort(id, String(info?.name ?? ""), undefined);
    post({
      type: "connect",
      port: id,
      args: mapFunctions(args, () => undefined).value as unknown[],
    });
    return framePort;
  };

  const getURL = (path?: unknown) =>
    buildExtensionUrl(extId, path == null ? "" : String(path));
  const localFunctions: Record<string, (...args: unknown[]) => unknown> = {
    "runtime.getManifest": () => structuredClone(init.manifest),
    "runtime.getURL": getURL,
    "runtime.connect": connect,
    "extension.getURL": getURL,
    "extension.getBackgroundPage": () => realm,
    "i18n.getMessage": (name, substitutions) =>
      readExtensionMessage(
        extId,
        init.messages,
        realm,
        String(name),
        substitutions,
      ),
    "i18n.getUILanguage": () => realm.navigator.language || "en",
    "identity.getRedirectURL": (path) =>
      identityRedirectUrl(extId, path === undefined ? undefined : String(path)),
    "contextMenus.create": (props, callback) => {
      const details = (props ?? {}) as { id?: string | number };
      const id = details.id ?? Math.random().toString(36).slice(2);
      call(
        ["contextMenus", "create"],
        typeof callback === "function"
          ? [{ ...details, id }, callback]
          : [{ ...details, id }],
      );
      return String(id);
    },
    "app.getDetails": () => null,
    csi: () => ({}),
    loadTimes: () => ({}),
  };

  const objects = new Map<string, unknown>();
  const build = (shape: ApiShape, path: string[]): unknown => {
    const name = path.join(".");
    switch (shape.kind) {
      case "function":
        return (
          localFunctions[name] ?? ((...args: unknown[]) => call(path, args))
        );
      case "event": {
        const kind = eventKind(path);
        const event =
          kind === "webRequest"
            ? webRequestEvent(path)
            : sharedEvent(path, kind);
        objects.set(name, event);
        return event;
      }
      case "value":
        return shape.value;
      case "lastError":
        return undefined;
      case "alias":
        return objects.get(shape.path.join("."));
      case "namespace": {
        if (name === "storage") {
          objects.set(name, storage);
          return storage;
        }
        const target: Record<string, unknown> = {};
        objects.set(name, target);
        for (const [key, member] of Object.entries(shape.members)) {
          if (member.kind === "lastError") {
            Object.defineProperty(target, key, {
              configurable: true,
              enumerable: true,
              get: () => lastError,
            });
            continue;
          }
          target[key] = build(member, [...path, key]);
        }
        return target;
      }
    }
  };

  const root = build(init.shape, []) as Record<string, unknown>;

  const reply = (id: number, value: unknown) => {
    try {
      post({ type: "reply", id, value });
    } catch {
      post({ type: "reply", id, value: undefined });
    }
  };

  port.onmessage = (event: MessageEvent<HostToFrameMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "result": {
        const pending = pendingCalls.get(message.id);
        if (!pending) return;
        pendingCalls.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.message));
        return;
      }
      case "event":
        listeners.get(message.listener)?.event?.(message.args);
        return;
      case "request": {
        const handler = listeners.get(message.listener)?.request;
        new Promise((resolve) => resolve(handler?.(message.args))).then(
          (value) => reply(message.id, value),
          (error) => {
            console.error(
              "[rivet] isolated background listener threw",
              error,
              NEGATIVE,
            );
            reply(message.id, undefined);
          },
        );
        return;
      }
      case "invoke": {
        const entry = exportedFunctions.get(message.fn);
        try {
          entry?.fn(...message.args);
        } catch (error) {
          console.error(
            "[rivet] isolated background callback threw",
            error,
            NEGATIVE,
          );
        }
        return;
      }
      case "release": {
        const entry = exportedFunctions.get(message.fn);
        if (!entry) return;
        entry.sent -= message.count;
        if (entry.sent > 0) return;
        exportedFunctions.delete(message.fn);
        functionIds.delete(entry.fn);
        return;
      }
      case "portOpen": {
        const framePort = openPort(message.port, message.name, message.sender);
        const handlers = listeners.get(message.listener);
        if (handlers?.portOpen) handlers.portOpen(framePort);
        else framePort.disconnect();
        return;
      }
      case "portMessage":
        ports.get(message.port)?.receive(message.message);
        return;
      case "portDisconnect":
        ports.get(message.port)?.close();
        return;
      case "responseTimeout":
        responseTimeoutMs = message.value;
        return;
    }
  };

  const chrome = withMissingMemberFallback(root);
  return {
    chrome,
    browser: withBrowserPromiseFallback(
      chrome,
      (realm as unknown as { Promise: PromiseConstructor }).Promise,
    ),
    responseTimeoutMs: () => responseTimeoutMs,
  };
}
