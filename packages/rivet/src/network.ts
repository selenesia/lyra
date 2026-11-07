import { encodeMochiTarget } from "./mochiEncoding";
import { RIVET_APP_BASE } from "./urlScheme";

const nativeFetch = globalThis.fetch.bind(globalThis);
const installedFetch = new WeakMap<Window, Window["fetch"]>();

function extensionRequestUrl(
  input: string,
  base: string,
  origin: string,
): string {
  const url = new URL(input, base);
  if (!/^https?:$/.test(url.protocol) || url.origin === origin) return url.href;
  return `${origin}${RIVET_APP_BASE}!!/${encodeMochiTarget(url.href)}/`;
}

function extensionSocketUrl(
  input: string,
  base: string,
  origin: string,
): string {
  const url = new URL(input, base);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!/^wss?:$/.test(url.protocol)) return url.href;
  const gateway = new URL(origin);
  gateway.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
  if (url.origin === gateway.origin && url.pathname.startsWith(`${RIVET_APP_BASE}!!/`))
    return url.href;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${gateway.origin}${RIVET_APP_BASE}!!/${encodeMochiTarget(url.href)}/`;
}

function abortWithoutResponse(xhr: XMLHttpRequest, timeoutMs: number): void {
  if (xhr.readyState >= xhr.HEADERS_RECEIVED) return;
  const timer = setTimeout(() => {
    if (xhr.readyState < xhr.HEADERS_RECEIVED) xhr.abort();
  }, timeoutMs);
  xhr.addEventListener("readystatechange", () => {
    if (xhr.readyState >= xhr.HEADERS_RECEIVED) clearTimeout(timer);
  });
}

export function installExtensionNetwork(
  win: Window,
  documentUrl?: string,
  responseTimeoutMs?: () => number | undefined,
): void {
  if (installedFetch.get(win) === win.fetch) return;
  const realm = win as Window &
    Pick<typeof globalThis, "XMLHttpRequest" | "WebSocket" | "EventSource">;
  const origin = globalThis.location.origin;
  const isContentScript =
    documentUrl &&
    /^https?:/.test(documentUrl) &&
    new URL(documentUrl).origin !== origin;
  if (isContentScript) return;
  (globalThis as { __LYRA_PREPARE_FRAME__?: (realm: Window) => void }).__LYRA_PREPARE_FRAME__?.(win);
  const base = () => win.document.baseURI;
  const requestUrl = (input: string) =>
    extensionRequestUrl(input, base(), origin);
  const originalFetch = win.fetch.bind(win);

  realm.fetch = async (input, init) => {
    const inputRequest =
      typeof input === "object" && "url" in input ? input : undefined;
    const source = inputRequest?.url ?? String(input);
    const absolute = new URL(source, base()).href;
    const target = requestUrl(source);
    if (target === absolute) {
      return originalFetch(input, init);
    }
    const request = new Request(inputRequest ?? absolute, {
      ...(inputRequest ? { referrerPolicy: inputRequest.referrerPolicy } : {}),
      ...init,
    });
    const forwarded: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers: request.headers,
      body:
        request.keepalive && request.body
          ? await request.arrayBuffer()
          : request.body,
      signal: request.signal,
      mode: request.mode,
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      duplex: "half",
    };
    const timeoutMs = responseTimeoutMs?.();
    if (!timeoutMs) return nativeFetch(new Request(target, forwarded));
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    forwarded.signal = AbortSignal.any([request.signal, timeout.signal]);
    try {
      return await nativeFetch(new Request(target, forwarded));
    } finally {
      clearTimeout(timer);
    }
  };
  installedFetch.set(win, realm.fetch);

  realm.XMLHttpRequest = new Proxy(realm.XMLHttpRequest, {
    construct(Target, args) {
      const xhr = Reflect.construct(Target, args) as XMLHttpRequest;
      const open = xhr.open;
      let routed = false;
      xhr.open = function (
        method: string,
        url: string | URL,
        ...args: unknown[]
      ) {
        const target = requestUrl(String(url));
        routed = target !== new URL(String(url), base()).href;
        return Reflect.apply(open, this, [method, target, ...args]);
      };
      if (responseTimeoutMs) {
        const send = xhr.send;
        xhr.send = function (...sendArgs: unknown[]) {
          Reflect.apply(send, this, sendArgs);
          const timeoutMs = routed ? responseTimeoutMs() : undefined;
          if (timeoutMs) abortWithoutResponse(this, timeoutMs);
        };
      }
      return xhr;
    },
  });

  if (globalThis.EventSource) {
    realm.EventSource = new Proxy(globalThis.EventSource, {
      construct(Target, args) {
        args[0] = requestUrl(String(args[0]));
        return Reflect.construct(Target, args);
      },
    });
  }
  if (globalThis.WebSocket) {
    realm.WebSocket = new Proxy(globalThis.WebSocket, {
      construct(Target, args) {
        args[0] = extensionSocketUrl(String(args[0]), base(), origin);
        return Reflect.construct(Target, args);
      },
    });
  }
  if (globalThis.navigator?.sendBeacon) {
    const sendBeacon = globalThis.navigator.sendBeacon.bind(
      globalThis.navigator,
    );
    Object.defineProperty(win.navigator, "sendBeacon", {
      configurable: true,
      value: (url: string | URL, body?: BodyInit | null) =>
        sendBeacon(requestUrl(String(url)), body),
    });
  }
}
