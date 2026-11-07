function mochiBase() {
  if (self.__MOCHI_BASE__ && self.__MOCHI_BASE__.startsWith("http")) {
    return self.__MOCHI_BASE__.replace(/\/+$/, "") + "/!!/";
  }
  if (self.MOCHI_BASE && self.MOCHI_BASE.startsWith("http")) {
    return self.MOCHI_BASE.replace(/\/+$/, "") + "/!!/";
  }
  const loc = self.location;
  const originBase = `${loc.origin}${MOCHI_PREFIX}`;
  const devBase = `${loc.protocol}//${loc.hostname}:4002${MOCHI_PREFIX}`;
  return originBase || devBase;
}

function mochiTarget(realUrl) {
  const base = mochiBase();
  const normalized = base.endsWith("/") ? base : base + "/";
  return realUrl.startsWith("http")
    ? `${normalized}${btoa(_adXorDec(encodeURIComponent(realUrl)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")}/`
    : `${MOCHI_PREFIX}${realUrl}`;
}

const STREAMED_BODY_MIN_BYTES = 1024 * 1024;

function mochiStreamsUploads() {
  try {
    const origin = new URL(mochiBase()).origin;
    return self.performance
      .getEntriesByType("resource")
      .some(
        (entry) =>
          entry.name.startsWith(origin) && /^h[23]/.test(entry.nextHopProtocol),
      );
  } catch {
    return false;
  }
}

const requestBodies = new WeakMap();

async function readRequestBody(request) {
  if (!(request.body instanceof ReadableStream) || !mochiStreamsUploads()) {
    return request.arrayBuffer();
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < STREAMED_BODY_MIN_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return joined.buffer;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function applyRequestBody(request, init) {
  let pending = requestBodies.get(request);
  if (!pending) {
    if (request.bodyUsed) return false;
    pending = readRequestBody(request);
    requestBodies.set(request, pending);
  }
  const body = await pending;
  if (body === null) return false;
  if (body instanceof ReadableStream) {
    requestBodies.set(request, Promise.resolve(null));
    init.duplex = "half";
  }
  init.body = body;
  return true;
}

async function mochiFetch(request, realUrl, timeoutMs = MOCHI_TIMEOUT_MS) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    cache: request.cache || "default",
    credentials: "include",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      if (!(await applyRequestBody(request, init))) return null;
    } catch {
      return null;
    }
  }
  const target = mochiTarget(realUrl);
  try {
    if (init.method === "GET" || init.method === "HEAD") {
      return await coalescedFetch(mochiCoalesceKey(request, target), () =>
        fetchWithTimeout(target, init, timeoutMs),
      );
    }
    return await fetchWithTimeout(target, init, timeoutMs);
  } catch {
    return null;
  }
}

async function fetchLargeFileStreaming(
  request,
  realUrl,
  timeoutMs = LARGE_TIMEOUT_MS,
) {
  const headers = new Headers(request.headers);
  const acceptEncoding = request.headers.get("Accept-Encoding") || "";
  if (!acceptEncoding.includes("gzip") && !acceptEncoding.includes("br")) {
    headers.set("Accept-Encoding", "gzip, br, deflate");
  }
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) headers.set("Range", rangeHeader);
  headers.set("Priority", "u=4");
  try {
    const urlObj = new URL(realUrl);
    headers.set("X-DNS-Prefetch-Control", "on");
    preconnectToOrigin(`${urlObj.protocol}//${urlObj.host}`);
  } catch {}
  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    cache: "no-store",
    credentials: "include",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      if (!(await applyRequestBody(request, init))) return null;
    } catch {
      return null;
    }
  }
  const target = mochiTarget(realUrl);
  try {
    const send = () => fetchWithTimeout(target, init, timeoutMs);
    const response =
      init.method === "GET" || init.method === "HEAD"
        ? await coalescedFetch(mochiCoalesceKey(request, target), send)
        : await send();
    if (!response) return null;
    const contentLength = response.headers.get("Content-Length");
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Accept-Ranges", "bytes");
    newHeaders.set(
      "Cache-Control",
      "public, max-age=3600, s-maxage=86400, immutable, stale-while-revalidate=86400",
    );
    newHeaders.set("Keep-Alive", "timeout=60, max=100");
    if (!rangeHeader && contentLength) {
      newHeaders.set("Content-Length", contentLength);
    } else {
      newHeaders.delete("Content-Length");
    }
    const etag = response.headers.get("ETag");
    if (etag) newHeaders.set("ETag", etag);
    const lastModified = response.headers.get("Last-Modified");
    if (lastModified) newHeaders.set("Last-Modified", lastModified);
    newHeaders.set("Vary", "Accept-Encoding, Range");
    try {
      const urlObj = new URL(realUrl);
      newHeaders.set("Link", `<${urlObj.origin}>; rel=preconnect`);
    } catch {}
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    newHeaders.set(
      "Access-Control-Allow-Headers",
      "Range, Accept-Encoding, If-Range, If-Match, If-None-Match",
    );
    newHeaders.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, ETag, Cache-Control, Last-Modified",
    );
    if (contentLength) {
      sendProgressUpdate(
        realUrl,
        parseInt(contentLength, 10),
        response.status,
      ).catch(() => {});
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch {
    return null;
  }
}

async function sendProgressUpdate(url, totalBytes, status) {
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    const payload = {
      type: "lyra-file-progress",
      url,
      totalBytes,
      status,
    };
    for (const client of clients) {
      try {
        client.postMessage(payload);
      } catch {}
    }
  } catch {}
}

function notifyTransportError() {
  _consecutiveProxyFailures++;
  const now = Date.now();
  if (now - _lastTransportError < 3000) return;
  _lastTransportError = now;
  self.clients
    .matchAll({ includeUncontrolled: true, type: "window" })
    .then((clients) => {
      const payload = {
        type: "transport-error",
        failures: _consecutiveProxyFailures,
      };
      for (const client of clients) client.postMessage(payload);
    });
}

function resetProxyHealth() {
  _consecutiveProxyFailures = 0;
}

function prefetchNavCacheKeyRequest(reqUrl) {
  try {
    const u = new URL(reqUrl);
    u.hash = "";
    return new Request(u.href, { method: "GET" });
  } catch {
    return new Request(String(reqUrl).split("#")[0], { method: "GET" });
  }
}

function trackPrefetchUrl(urlStr) {
  try {
    const urlKey = prefetchNavCacheKeyRequest(urlStr).url;
    if (_activePrefetches.has(urlKey)) return false;
    const lastAt = _prefetchTimes.get(urlKey);
    const age = lastAt ? Date.now() - lastAt : Infinity;
    if (age < PREFETCH_VALIDITY) return false;
    return true;
  } catch {
    return false;
  }
}

function rememberPrefetchTime(urlKey) {
  const now = Date.now();
  _prefetchTimes.delete(urlKey);
  _prefetchTimes.set(urlKey, now);
  for (const [key, at] of _prefetchTimes) {
    if (now - at < PREFETCH_VALIDITY) break;
    _prefetchTimes.delete(key);
  }
}

async function matchPrefetchedNavHtml(request) {
  const key = prefetchNavCacheKeyRequest(request.url);
  try {
    const cache = await caches.open(PREFETCH_CACHE);
    let hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    hit = await cache.match(key);
    if (hit) return hit;
  } catch {}
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    let hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    return await cache.match(key);
  } catch {
    return null;
  }
}

async function ensureFolioConfig() {
  if (folioConfigLoaded) return;
  if (!folio || typeof folio.loadConfig !== "function") {
    folioConfigLoaded = true;
    return;
  }
  if (!folioConfigPromise) {
    const pending = folio.loadConfig().then(() => {
      folioConfigLoaded = true;
    });
    folioConfigPromise = pending;
    pending.catch(() => {
      if (folioConfigPromise === pending) folioConfigPromise = null;
    });
  }
  await folioConfigPromise;
}

async function runFolioProxy(engine, event, timeoutMs, notifyOnFailure = true) {
  const controllerTimeoutMs = Math.max(1, timeoutMs - 250);
  const proxyP =
    typeof engine.fetch === "function"
      ? engine.fetch(event, controllerTimeoutMs)
      : engine.route(event, controllerTimeoutMs);
  const response = await tryWithTimeout(proxyP, timeoutMs);
  if (response && response.ok) resetProxyHealth();
  if (!response && notifyOnFailure) notifyTransportError();
  return response;
}

async function reviveFolioRoutes() {
  try {
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
      type: "window",
    });
    for (const client of clients) {
      try {
        client.postMessage({ $controller$swrevive: { routeMiss: true } });
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch {}
}

function isUnreadableFolioRoute(url) {
  if (url.pathname !== FOLIO_PATH || !url.searchParams.has("s")) return false;
  try {
    folio.routeDestination(url.href);
    return false;
  } catch {
    return true;
  }
}

function staleFolioRouteResponse(isNavigate) {
  const message = swNegativeMessage(
    "this link expired after an update, reopen the site",
  );
  const headers = {
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  if (!isNavigate) {
    return new Response(message, {
      status: 410,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>link expired</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box;text-align:center"><p>${message}</p></body></html>`,
    {
      status: 410,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

async function folioRouteMissFallback(request, url, realUrl, isNavigate) {
  notifyTransportError();
  if (realUrl && realUrl.startsWith("http")) {
    const fallback = await mochiFetch(
      request,
      realUrl,
      isNavigate ? PROXY_NAV_TIMEOUT_MS : MOCHI_TIMEOUT_MS,
    );
    if (fallback && (fallback.ok || fallback.status === 304)) {
      return isNavigate ? patchHtml(fallback, realUrl) : fallback;
    }
  }
  return timeoutFallbackResponse(request, url);
}

async function handlePrefetchProxyRequest(event) {
  const { request } = event;
  const urlKey = prefetchNavCacheKeyRequest(request.url).url;
  const active = _activePrefetches.get(urlKey);
  if (active) {
    try {
      const response = await active;
      return response ? response.clone() : new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  }
  const fetchPrefetchResponse = async () => {
    try {
      if (!isFolio) return new Response(null, { status: 204 });
      await ensureFolioConfig();
      if (
        typeof folio.shouldRoute === "function" &&
        !folio.shouldRoute(event)
      ) {
        return new Response(null, { status: 204 });
      }
      const response = await runFolioProxy(
        folio,
        event,
        PROXY_NAV_TIMEOUT_MS,
        false,
      );
      if (response && response.ok) {
        try {
          const cacheKey = prefetchNavCacheKeyRequest(request.url);
          const cache = await caches.open(PREFETCH_CACHE);
          await cache.put(cacheKey, response.clone());
          rememberPrefetchTime(urlKey);
          capCache(PREFETCH_CACHE, MAX_PREFETCH_ENTRIES);
        } catch {}
        return response;
      }
      return response || new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  };
  const prefetchPromise = fetchPrefetchResponse();
  _activePrefetches.set(urlKey, prefetchPromise);
  try {
    const response = await prefetchPromise;
    if (response && response.ok) {
      try {
        _prefetchedResponses.set(urlKey, response.clone());
        if (_prefetchedResponses.size > MAX_MEM) {
          const oldest = _prefetchedResponses.keys().next().value;
          _prefetchedResponses.delete(oldest);
        }
      } catch {}
    }
    return response ? response.clone() : new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 204 });
  } finally {
    _activePrefetches.delete(urlKey);
  }
}

async function prefetchProxiedNavFromClient(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
    if (url.pathname !== FOLIO_PATH || !url.searchParams.has("s")) return;
  if (!trackPrefetchUrl(urlStr)) return;
  const request = new Request(urlStr, { method: "GET" });
  const event = {
    request,
    type: "fetch",
    respondWith: () => {},
    waitUntil: () => {},
    preventDefault: () => {},
    preloadResponse: Promise.resolve(null),
    clientId: "",
    resultingClientId: "",
    replacesClientId: "",
  };
  try {
    const response = await handlePrefetchProxyRequest(event);
    if (!response || !response.ok) return;
  } catch {
    return;
  }
}
