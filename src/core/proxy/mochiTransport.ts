import type {
  ProxyTransport,
  RawHeaders,
  TransferrableResponse,
  WebSocketDataType,
} from "@mercuryworkshop/proxy-transports";
import { negativeMessage } from "../runtime/messages.ts";

const PROTOCOL_PATH = "/!!folio/";
const SESSION_STORAGE_KEY = "__lyra_folio_session";
const CIRCUIT_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const MAX_HEADER_ENVELOPE_CHARS = 128 * 1024;

type MochiMeta = {
  status: number;
  status_text?: string;
  statusText?: string;
  url?: string;
  raw_headers?: RawHeaders;
  rawHeaders?: RawHeaders;
};

type MochiGlobals = typeof globalThis & {
  __MOCHI_BASE__?: string;
  MOCHI_BASE?: string;
  __FOLIO_MOCHI_TRANSPORT__?: boolean;
};

function base64UrlEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode<T>(value: string): T {
  let input = value.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  const bytes = Uint8Array.from(atob(input), (character) =>
    character.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function createSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const value = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(SESSION_STORAGE_KEY, value);
    return value;
  } catch {
    return crypto.randomUUID().replace(/-/g, "");
  }
}

export function resolveMochiOrigin(): URL {
  const globals = globalThis as MochiGlobals;
  const configured = globals.__MOCHI_BASE__ || globals.MOCHI_BASE;
  const base = new URL(configured || location.origin, location.href);
  base.pathname = base.pathname
    .replace(/\/+$/, "")
    .replace(/\/!!(?:raw|folio)?$/, "")
    .replace(/\/+$/, "");
  base.search = "";
  base.hash = "";
  return base;
}

function endpoint(base: URL, path: string): URL {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${PROTOCOL_PATH}${path}`;
  return url;
}

function isIdempotent(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isRawHeaders(value: unknown): value is RawHeaders {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

function toTransferrableResponse(response: Response): TransferrableResponse {
  return {
    body: response.body ?? new ArrayBuffer(0),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  };
}

function unavailableResponse(): TransferrableResponse {
  return toTransferrableResponse(
    new Response(negativeMessage("mochi gateway is unavailable"), {
      status: 502,
      statusText: "Bad Gateway",
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-error-class": "gateway",
      },
    }),
  );
}

async function requestWithFallback(
  fallback: ProxyTransport,
  remote: URL,
  method: string,
  body: BodyInit | null,
  headers: RawHeaders,
  signal: AbortSignal | undefined,
): Promise<TransferrableResponse> {
  try {
    return await fallback.request(remote, method, body, headers, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailableResponse();
  }
}

export class MochiTransport implements ProxyTransport {
  ready = false;

  private initPromise: Promise<void> | null = null;
  private serverAvailable = false;
  private failures = 0;
  private circuitOpenUntil = 0;
  private uploadsStreamable = false;
  private readonly sessionId = createSessionId();

  constructor(
    private readonly fallback: ProxyTransport,
    private readonly base = resolveMochiOrigin(),
  ) {}

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const fallbackInit = (async () => {
        if (!this.fallback.ready) {
          try {
            await this.fallback.init();
          } catch {}
        }
      })();
      const globals = globalThis as MochiGlobals;
      if (globals.__FOLIO_MOCHI_TRANSPORT__ === false) {
        this.serverAvailable = false;
        await fallbackInit;
        this.ready = true;
        return;
      }

      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 3_000);
      const stopWatchingProtocol = this.watchUploadProtocol();
      try {
        const response = await fetch(endpoint(this.base, "capabilities"), {
          cache: "no-store",
          credentials: "omit",
          signal: abort.signal,
        });
        const health = response.ok ? await response.json() : null;
        this.serverAvailable = health?.ok === true && health?.protocol === 1;
      } catch {
        this.serverAvailable = false;
      } finally {
        clearTimeout(timeout);
        if (!this.serverAvailable) stopWatchingProtocol();
      }
      await fallbackInit;
      this.ready = true;
    })().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  connect(
    url: URL,
    protocols: string[],
    requestHeaders: RawHeaders,
    onopen: (protocol: string, extensions: string) => void,
    onmessage: (message: WebSocketDataType) => void,
    onclose: (code: number, reason: string) => void,
    onerror: (error: string) => void,
  ): [
    (message: WebSocketDataType) => void,
    (code: number, reason: string) => void,
  ] {
    return this.fallback.connect(
      url,
      protocols,
      requestHeaders,
      onopen,
      onmessage,
      onclose,
      onerror,
    );
  }

  private watchUploadProtocol(): () => void {
    if (typeof PerformanceObserver === "undefined") return () => {};
    const capabilities = endpoint(this.base, "capabilities").href;
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntriesByName(
        capabilities,
      ) as PerformanceResourceTiming[];
      if (!entries.length) return;
      observer.disconnect();
      if (entries.some((entry) => /^h[23]/.test(entry.nextHopProtocol))) {
        this.uploadsStreamable = true;
      }
    });
    try {
      observer.observe({ type: "resource" });
    } catch {
      return () => {};
    }
    return () => observer.disconnect();
  }

  private streamsUploads(): boolean {
    if (this.uploadsStreamable) return true;
    const entries = performance.getEntriesByName(
      endpoint(this.base, "capabilities").href,
    ) as PerformanceResourceTiming[];
    this.uploadsStreamable = entries.some((entry) =>
      /^h[23]/.test(entry.nextHopProtocol),
    );
    return this.uploadsStreamable;
  }

  async request(
    remote: URL,
    method: string,
    body: BodyInit | null,
    headers: RawHeaders,
    signal: AbortSignal | undefined,
  ): Promise<TransferrableResponse> {
    if (!this.ready) await this.init();
    method = method.toUpperCase();

    const envelope = base64UrlEncode(headers);
    if (
      !this.serverAvailable ||
      Date.now() < this.circuitOpenUntil ||
      envelope.length > MAX_HEADER_ENVELOPE_CHARS
    ) {
      return requestWithFallback(
        this.fallback,
        remote,
        method,
        body,
        headers,
        signal,
      );
    }

    if (
      typeof ReadableStream !== "undefined" &&
      body instanceof ReadableStream &&
      !this.streamsUploads()
    ) {
      body = await new Response(body).arrayBuffer();
    }

    const requestUrl = endpoint(
      this.base,
      `request/${encodeURIComponent(remote.href)}`,
    );
    const requestHeaders = new Headers({
      "x-mochi-folio-headers": envelope,
      "x-mochi-folio-session": this.sessionId,
    });
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: requestHeaders,
      body: method === "GET" || method === "HEAD" ? null : body,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    };
    if (
      typeof ReadableStream !== "undefined" &&
      body instanceof ReadableStream
    ) {
      init.duplex = "half";
    }

    try {
      const response = await fetch(requestUrl, init);
      const encodedMeta = response.headers.get("x-mochi-upstream-meta");
      if (!response.ok || !encodedMeta) {
        throw new Error(
          negativeMessage(`mochi gateway failed with ${response.status}`),
        );
      }
      const meta = base64UrlDecode<MochiMeta>(encodedMeta);
      const rawHeaders = meta.raw_headers ?? meta.rawHeaders;
      if (
        !Number.isInteger(meta.status) ||
        meta.status! < 100 ||
        meta.status! > 599 ||
        !isRawHeaders(rawHeaders)
      ) {
        throw new Error(
          negativeMessage("mochi returned invalid upstream metadata"),
        );
      }
      this.failures = 0;
      this.circuitOpenUntil = 0;
      return {
        body: response.body ?? new ArrayBuffer(0),
        headers: rawHeaders,
        status: meta.status!,
        statusText: meta.status_text ?? meta.statusText ?? "",
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.failures += 1;
      if (this.failures >= CIRCUIT_FAILURES) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      }
      if (isIdempotent(method)) {
        return requestWithFallback(
          this.fallback,
          remote,
          method,
          body,
          headers,
          signal,
        );
      }
      return unavailableResponse();
    }
  }
}
