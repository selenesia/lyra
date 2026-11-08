import {
  REMOTE_MESSAGE_LISTENER,
  type MessageAnswer,
} from "../chromeApi/common";
import type { Listener } from "../eventHub";
import type { BackgroundInfo } from "../manifest";
import { NEGATIVE, negativeMessage } from "../messages";
import type {
  ExtensionState,
  RivetRegistry,
  WebRequestDetails,
  WebRequestEventName,
} from "../registry";
import type { RivetHostBindings } from "../types";
import {
  encodedFunctionId,
  ISOLATED_BACKGROUND_INIT,
  restoreFunctions,
  type ApiShape,
  type EncodedFunction,
  type FrameToHostMessage,
  type HostToFrameMessage,
  type IsolatedBackgroundInit,
} from "./protocol";

const ISOLATED_WEB_REQUEST_WAIT_MS = 10_000;

interface EventApi {
  addListener: (listener: Listener, ...options: unknown[]) => void;
  removeListener: (listener: Listener) => void;
}

interface HostPort {
  name: string;
  sender: unknown;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: EventApi;
  onDisconnect: EventApi;
}

interface ImportedFunction {
  ref: WeakRef<Listener>;
  record: { count: number };
}

export interface IsolatedBackgroundConnection {
  ready: Promise<boolean>;
  close: () => void;
}

export interface IsolatedBackgroundOptions {
  target: Window;
  ext: ExtensionState;
  registry: RivetRegistry;
  host: RivetHostBindings;
  api: object;
  background: NonNullable<BackgroundInfo>;
  senderUrl: string | undefined;
}

function isEventApi(value: unknown): value is EventApi {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EventApi).addListener === "function" &&
    typeof (value as EventApi).removeListener === "function"
  );
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function hasOwnEventMethods(value: object): boolean {
  return ["addListener", "removeListener"].every(
    (name) =>
      typeof Object.getOwnPropertyDescriptor(value, name)?.value === "function",
  );
}

export function describeApi(api: object): ApiShape {
  const seen = new Map<object, string[]>();
  const visit = (value: unknown, path: string[]): ApiShape => {
    if (typeof value === "function") return { kind: "function" };
    if (typeof value !== "object" || value === null)
      return { kind: "value", value };
    const known = seen.get(value);
    if (known) return { kind: "alias", path: known };
    if (hasOwnEventMethods(value)) {
      seen.set(value, path);
      return { kind: "event" };
    }
    if (Array.isArray(value) || !isPlainRecord(value)) {
      try {
        return { kind: "value", value: structuredClone(value) };
      } catch {
        return { kind: "value", value: undefined };
      }
    }
    seen.set(value, path);
    const members: Record<string, ApiShape> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (key === "lastError" && descriptor.get) {
        members[key] = { kind: "lastError" };
        continue;
      }
      const member = descriptor.get
        ? descriptor.get.call(value)
        : descriptor.value;
      members[key] = visit(member, [...path, key]);
    }
    return { kind: "namespace", members };
  };
  return visit(api, []);
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.endsWith(NEGATIVE)
    ? error.message
    : negativeMessage("extension api call failed");
}

function isMessageAnswer(value: unknown): value is MessageAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MessageAnswer).answered === "boolean"
  );
}

function isBlocking(extraInfoSpec: unknown): boolean {
  return (
    Array.isArray(extraInfoSpec) &&
    (extraInfoSpec.includes("blocking") ||
      extraInfoSpec.includes("asyncBlocking"))
  );
}

export function connectIsolatedBackground(
  options: IsolatedBackgroundOptions,
): IsolatedBackgroundConnection {
  const { target, ext, registry, host, api } = options;
  const channel = new MessageChannel();
  const port = channel.port1;
  let closed = false;
  let nextRequestId = 0;
  let nextPortId = 0;
  let responseTimeoutMs = host.extensionResponseTimeoutMs?.(ext.id);
  const subscriptions = new Map<number, () => void>();
  const hostPorts = new Map<string, { port: HostPort; detach: () => void }>();
  const pendingRequests = new Map<number, (value: unknown) => void>();
  const importedFunctions = new Map<number, ImportedFunction>();

  const send = (message: HostToFrameMessage): boolean => {
    if (closed) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      try {
        port.postMessage(JSON.parse(JSON.stringify(message)));
        return true;
      } catch (error) {
        console.warn(
          "[rivet] isolated background message could not be sent",
          message.type,
          error,
          NEGATIVE,
        );
        return false;
      }
    }
  };

  const releaser = new FinalizationRegistry<{
    id: number;
    record: { count: number };
  }>(({ id, record }) => {
    if (importedFunctions.get(id)?.record === record)
      importedFunctions.delete(id);
    send({ type: "release", fn: id, count: record.count });
  });

  const importFunction = (encoded: EncodedFunction): Listener => {
    const id = encodedFunctionId(encoded);
    const known = importedFunctions.get(id);
    const alive = known?.ref.deref();
    if (known && alive) {
      known.record.count += 1;
      return alive;
    }
    const record = { count: 1 };
    const proxy = (...args: unknown[]) => {
      send({ type: "invoke", fn: id, args });
    };
    Object.defineProperty(proxy, "toString", {
      configurable: true,
      value: () => encoded.source,
    });
    importedFunctions.set(id, { ref: new WeakRef(proxy), record });
    releaser.register(proxy, { id, record });
    return proxy;
  };

  const resolvePath = (path: string[]) => {
    let parent: unknown;
    let value: unknown = api;
    for (const key of path) {
      parent = value;
      value =
        value === null || value === undefined
          ? undefined
          : Reflect.get(value as object, key);
    }
    return { parent, value };
  };

  const request = (listener: number, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = ++nextRequestId;
      pendingRequests.set(id, resolve);
      if (!send({ type: "request", id, listener, args })) {
        pendingRequests.delete(id);
        resolve(undefined);
      }
    });
  };

  const updateResponseTimeout = () => {
    const value = host.extensionResponseTimeoutMs?.(ext.id);
    if (value === responseTimeoutMs) return;
    responseTimeoutMs = value;
    send({ type: "responseTimeout", value });
  };

  const attachPort = (id: string, hostPort: HostPort) => {
    const onMessage = (message: unknown) =>
      send({ type: "portMessage", port: id, message });
    const onDisconnect = () => {
      detach();
      send({ type: "portDisconnect", port: id });
    };
    const detach = () => {
      hostPort.onMessage.removeListener(onMessage);
      hostPort.onDisconnect.removeListener(onDisconnect);
      hostPorts.delete(id);
    };
    hostPort.onMessage.addListener(onMessage);
    hostPort.onDisconnect.addListener(onDisconnect);
    hostPorts.set(id, { port: hostPort, detach });
  };

  const listenToWebRequest = (
    listener: number,
    path: string[],
    [filter, extraInfoSpec]: unknown[],
  ) => {
    const event = path[1] as WebRequestEventName;
    if (!isEventApi(resolvePath(path).value)) return;
    const proxy = isBlocking(extraInfoSpec)
      ? (details: WebRequestDetails) => request(listener, [details])
      : (details: WebRequestDetails) => {
          send({ type: "event", listener, args: [details] });
          return undefined;
        };
    registry.addWebRequestListener(
      ext.id,
      event,
      proxy,
      filter && typeof filter === "object" ? filter : {},
      ISOLATED_WEB_REQUEST_WAIT_MS,
    );
    subscriptions.set(listener, () =>
      registry.removeWebRequestListener(ext.id, event, proxy),
    );
    updateResponseTimeout();
  };

  const listen = (message: Extract<FrameToHostMessage, { type: "listen" }>) => {
    const { listener, path, kind } = message;
    if (kind === "webRequest") {
      listenToWebRequest(listener, path, message.options);
      return;
    }
    const event = resolvePath(path).value;
    if (!isEventApi(event)) return;
    let proxy: Listener;
    if (kind === "message") {
      proxy = (message: unknown, sender: unknown) =>
        request(listener, [message, sender]).then((answer) =>
          isMessageAnswer(answer) ? answer : { answered: false },
        );
      Object.defineProperty(proxy, REMOTE_MESSAGE_LISTENER, { value: true });
    } else if (kind === "connect") {
      proxy = (hostPort: HostPort) => {
        const id = `h${++nextPortId}`;
        attachPort(id, hostPort);
        send({
          type: "portOpen",
          listener,
          port: id,
          name: hostPort.name,
          sender: hostPort.sender,
        });
      };
    } else {
      proxy = (...args: unknown[]) => {
        send({ type: "event", listener, args });
      };
    }
    event.addListener(proxy);
    subscriptions.set(listener, () => event.removeListener(proxy));
  };

  const call = (message: Extract<FrameToHostMessage, { type: "call" }>) => {
    const fail = (error: unknown) =>
      send({
        type: "result",
        id: message.id,
        ok: false,
        message: errorText(error),
      });
    const { parent, value } = resolvePath(message.path);
    if (typeof value !== "function") {
      fail(new Error(negativeMessage("extension api is unavailable")));
      return;
    }
    const args = message.functions
      ? (restoreFunctions(message.args, importFunction) as unknown[])
      : message.args;
    let result: unknown;
    try {
      result = Reflect.apply(value, parent, args);
    } catch (error) {
      fail(error);
      return;
    }
    Promise.resolve(result).then((resolved) => {
      if (!send({ type: "result", id: message.id, ok: true, value: resolved }))
        fail(
          new Error(
            negativeMessage("extension api result could not be transferred"),
          ),
        );
    }, fail);
  };

  let resolveReady: (started: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  port.onmessage = (event: MessageEvent<FrameToHostMessage>) => {
    if (closed) return;
    const message = event.data;
    switch (message.type) {
      case "call":
        call(message);
        return;
      case "listen":
        listen(message);
        return;
      case "unlisten": {
        subscriptions.get(message.listener)?.();
        subscriptions.delete(message.listener);
        updateResponseTimeout();
        return;
      }
      case "reply": {
        const resolve = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        resolve?.(message.value);
        return;
      }
      case "connect": {
        const runtime = (api as { runtime?: { connect?: unknown } }).runtime;
        const hostPort =
          typeof runtime?.connect === "function"
            ? (runtime.connect(...message.args) as HostPort)
            : null;
        if (hostPort) attachPort(message.port, hostPort);
        else send({ type: "portDisconnect", port: message.port });
        return;
      }
      case "portPost": {
        const entry = hostPorts.get(message.port);
        try {
          entry?.port.postMessage(message.message);
        } catch {
          entry?.detach();
          send({ type: "portDisconnect", port: message.port });
        }
        return;
      }
      case "portDisconnect": {
        const entry = hostPorts.get(message.port);
        entry?.detach();
        entry?.port.disconnect();
        return;
      }
      case "storageListening":
        send({
          type: "result",
          id: message.id,
          ok: true,
          value: registry.hasListenersOutsideBackground(
            ext.id,
            (events) => events.storageOnChanged,
          ),
        });
        return;
      case "storageChanged":
        registry.broadcastOutsideBackground(
          ext.id,
          (events) => events.storageOnChanged,
          [message.changes, message.area],
        );
        return;
      case "ready":
        resolveReady(true);
        return;
      case "failed":
        resolveReady(false);
        return;
    }
  };

  const init: IsolatedBackgroundInit = {
    type: ISOLATED_BACKGROUND_INIT,
    extId: ext.id,
    manifest: ext.manifest,
    messages: ext.messages,
    shape: describeApi(api),
    background: options.background,
    senderUrl: options.senderUrl,
    responseTimeoutMs,
  };
  target.postMessage(init, globalThis.location.origin, [channel.port2]);

  return {
    ready,
    close: () => {
      if (closed) return;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const { port: hostPort, detach } of [...hostPorts.values()]) {
        detach();
        hostPort.disconnect();
      }
      closed = true;
      for (const resolve of pendingRequests.values()) resolve(undefined);
      pendingRequests.clear();
      importedFunctions.clear();
      resolveReady(false);
      port.close();
    },
  };
}
