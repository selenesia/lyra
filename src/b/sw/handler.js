self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter(
              (k) =>
                k.startsWith("lyra-") &&
                k !== SHELL_CACHE &&
                k !== RUNTIME_CACHE &&
                k !== PREFETCH_CACHE &&
                k !== LARGE_CACHE,
            )
            .map((k) => caches.delete(k)),
        );
      }),
      self.registration.navigationPreload
        ? (self.__LYRA_APP_BASE__
          ? self.registration.navigationPreload.disable()
          : self.registration.navigationPreload.enable())
        : Promise.resolve(),
    ]).then(() => self.clients.claim()),
  );
});

async function handleLargeFile(request, realUrl) {
  try {
    if (!isRangeRequest(request)) {
      const cache = await caches.open(LARGE_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        const refreshKey = `large-refresh\n${request.method}\n${request.url}\n${JSON.stringify([...request.headers])}`;
        coalescedFetch(refreshKey, async () => {
          const fresh = await fetchLargeFileStreaming(
            request,
            realUrl,
            LARGE_TIMEOUT_MS,
          );
          if (fresh && fresh.ok && responseFitsCache(fresh)) {
            try {
              await cache.put(request, fresh);
              await capCache(LARGE_CACHE, MAX_LARGE_CACHE_ENTRIES);
            } catch {}
          } else {
            try {
              await fresh?.body?.cancel();
            } catch {}
          }
        }).catch(() => {});
        return cached;
      }
    }
    const response = await fetchLargeFileStreaming(
      request,
      realUrl,
      LARGE_TIMEOUT_MS,
    );
    if (response && response.ok) {
      if (!isRangeRequest(request)) {
        if (responseFitsCache(response)) {
          const cache = await caches.open(LARGE_CACHE);
          cache.put(request, response.clone()).catch(() => {});
          capCache(LARGE_CACHE, MAX_LARGE_CACHE_ENTRIES);
        }
      }
      return response;
    }
    const fallback = await mochiFetch(request, realUrl, LARGE_TIMEOUT_MS);
    return (
      fallback ||
      new Response(swNegativeMessage("gateway timeout"), { status: 504 })
    );
  } catch {
    const fallback = await mochiFetch(request, realUrl, LARGE_TIMEOUT_MS);
    return (
      fallback ||
      new Response(swNegativeMessage("gateway timeout"), { status: 504 })
    );
  }
}

async function tryConsumeActivePrefetch(urlKey) {
  const active = _activePrefetches.get(urlKey);
  if (active) {
    try {
      const prefRes = await active;
      if (prefRes && prefRes.ok) return prefRes.clone();
    } catch {}
  }
  if (_prefetchedResponses.has(urlKey)) {
    const memHit = _prefetchedResponses.get(urlKey);
    _prefetchedResponses.delete(urlKey);
    try {
      if (memHit && memHit.ok) return memHit.clone();
    } catch {}
  }
  return null;
}

async function tryMatchPrefetchedNav(request, urlKey) {
  const lastAt = _prefetchTimes.get(urlKey);
  const age = lastAt ? Date.now() - lastAt : Infinity;
  if (age < PREFETCH_VALIDITY) {
    const prefHit = await matchPrefetchedNavHtml(request);
    if (prefHit) return prefHit.clone();
  } else if (_prefetchTimes.has(urlKey)) {
    _prefetchTimes.delete(urlKey);
  }
  return null;
}

async function runProxyEngine(
  engine,
  event,
  request,
  url,
  realUrl,
  isNavigate,
) {
  if (isNavigate && request.method === "GET") {
    try {
      const urlKey = prefetchNavCacheKeyRequest(request.url).url;
      const prefetched = await tryConsumeActivePrefetch(urlKey);
      if (prefetched) return prefetched;
      const navHit = await tryMatchPrefetchedNav(request, urlKey);
      if (navHit) return navHit;
    } catch {}
  }
  const timeoutMs = isNavigate
    ? PROXY_NAV_TIMEOUT_MS
    : PROXY_SUBRESOURCE_TIMEOUT_MS;
  const fallbackRequest =
    realUrl &&
    isGoogleVideoUrl(realUrl) &&
    request.method !== "GET" &&
    request.method !== "HEAD"
      ? request.clone()
      : request;
  try {
    const response = await runFolioProxy(engine, event, timeoutMs, true);
    if (response) {
      if (
        !isNavigate &&
        response.headers.get("x-error-class") === "gateway"
      ) {
        return Response.error();
      }
      if (
        realUrl &&
        (response.status === 401 || response.status === 403) &&
        isGoogleVideoUrl(realUrl)
      ) {
        const fallback = await mochiFetch(
          fallbackRequest,
          realUrl,
          LARGE_TIMEOUT_MS,
        );
        if (fallback?.ok) return fallback;
      }
      return response;
    }
    return timeoutFallbackResponse(request, url);
  } catch {
    notifyTransportError();
    return timeoutFallbackResponse(request, url);
  }
}

function isGoogleVideoUrl(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname;
    return (
      hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com")
    );
  } catch {
    return false;
  }
}

function upstreamOriginFromUrl(locationUrl) {
  try {
    const url =
      typeof locationUrl === "string" ? new URL(locationUrl) : locationUrl;
    if (url.origin !== self.location.origin) return null;
    if (url.pathname.startsWith(MOCHI_PREFIX)) {
      let encoded = url.pathname.slice(MOCHI_PREFIX.length).replace(/\/+$/, "");
      if (!encoded.startsWith("http")) {
        try {
          let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
          while (base64.length % 4) base64 += "=";
          const raw = atob(base64);
          const decoded = _adXorDec(raw);
          const result = decodeURIComponent(decoded);
          if (result.startsWith("http")) return new URL(result).origin;
        } catch {}
      } else {
        try {
          return new URL(encoded).origin;
        } catch {}
      }
    }
    if (url.pathname === FOLIO_PATH) {
      const destination = unwrapUrl(url);
      if (destination) return new URL(destination).origin;
    }
  } catch {}
  return null;
}

async function upstreamOriginFromClient(event) {
  try {
    const client = await self.clients.get(event.clientId);
    if (!client) return null;
    return upstreamOriginFromUrl(client.url);
  } catch {
    return null;
  }
}

async function handleLocalOriginGet(event, request, url, preloadPromise) {
  const path = url.pathname;
  if (
    request.destination === "document" ||
    path === "/" ||
    path.endsWith(".html")
  ) {
    let networkResponse = null;
    try {
      const preloaded = await preloadPromise;
      if (preloaded && (preloaded.ok || preloaded.status === 304)) {
        networkResponse = preloaded;
      } else {
        networkResponse = await fetch(request).catch(() => null);
      }
    } catch {
      networkResponse = await fetch(request).catch(() => null);
    }
    if (networkResponse && networkResponse.ok) {
      const clone = networkResponse.clone();
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.put(request, clone).catch(() => {}));
      return networkResponse;
    }
    if (networkResponse && networkResponse.status === 304)
      return networkResponse;
    const cached = await caches.match(request);
    if (cached) return cached;
    if (networkResponse) return networkResponse;
    return new Response(swNegativeMessage("offline"), { status: 503 });
  }
  if (
    CACHEABLE_EXT.test(path) ||
    path.startsWith("/assets/") ||
    path.startsWith("/bmux/") ||
    path.startsWith("/epoxy/") ||
    path.startsWith("/libcurl/")
  ) {
    const isFirstPartyAsset =
      path.startsWith("/assets/") ||
      path.startsWith("/b/") ||
      path.startsWith("/bmux/") ||
      path.startsWith("/epoxy/") ||
      path.startsWith("/libcurl/");
    const isHashed = HASHED_ASSET_REGEX.test(path);
    const cached = await caches.match(request);
    if (
      cached &&
      VERSIONED_ASSET_REGEX.test(path) &&
      request.cache !== "reload" &&
      request.cache !== "no-cache" &&
      request.cache !== "no-store" &&
      !request.headers.get("cache-control") &&
      !request.headers.get("pragma")
    ) {
      return cached;
    }
    if (cached && !isFirstPartyAsset) {
      if (!isHashed) {
        fetch(request)
          .then((response) => {
            if (response && response.ok) {
              if (responseFitsCache(response)) {
                caches.open(RUNTIME_CACHE).then((cache) => {
                  cache.put(request, response);
                  capCache(RUNTIME_CACHE, MAX_RUNTIME);
                });
              }
            }
          })
          .catch(() => {});
      }
      return cached;
    }
    const response = await fetch(request).catch(() => null);
    if (response && response.ok) {
      if (responseFitsCache(response)) {
        const clone = response.clone();
        caches.open(RUNTIME_CACHE).then((cache) => {
          cache.put(request, clone);
          capCache(RUNTIME_CACHE, MAX_RUNTIME);
        });
      }
      return response;
    }
    if (!response || !response.ok) {
      try {
        let upstreamOrigin = await upstreamOriginFromClient(event);
        if (!upstreamOrigin) {
          const referer = request.headers.get("Referer") || "";
          if (referer) upstreamOrigin = upstreamOriginFromUrl(referer);
        }
        if (upstreamOrigin) {
          const upstreamUrl = upstreamOrigin + path + (url.search || "");
          const fallbackResponse = await mochiFetch(
            request,
            upstreamUrl,
            MOCHI_TIMEOUT_MS,
          );
          if (fallbackResponse && fallbackResponse.ok) {
            if (responseFitsCache(fallbackResponse)) {
              const clone = fallbackResponse.clone();
              caches.open(RUNTIME_CACHE).then((cache) => {
                cache.put(request, clone);
                capCache(RUNTIME_CACHE, MAX_RUNTIME);
              });
            }
            return fallbackResponse;
          }
        }
      } catch {}
    }
    if (cached) return cached;
    if (response) return response;
  }
  return await fetch(request);
}

async function handleCacheableCrossOrigin(request, url, realUrl) {
  const ext = urlExt(realUrl);
  const dest = request.destination;
  const accept = request.headers.get("Accept") || "";
  const isCacheableAsset =
    dest === "video" ||
    dest === "audio" ||
    dest === "image" ||
    dest === "font" ||
    dest === "track" ||
    accept.startsWith("image/") ||
    accept.startsWith("video/") ||
    accept.startsWith("audio/") ||
    accept.startsWith("font/") ||
    STATIC_REGEX.test(url.pathname) ||
    CACHEABLE_ASSET_EXTS.has(ext);
  const preferProxyOverMochi =
    isFolio && (dest === "script" || ext === ".js" || ext === ".mjs");
  if (
    !isCacheableAsset ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    realUrl.includes(self.location.host) ||
    preferProxyOverMochi
  ) {
    return null;
  }
  try {
    const cached = await caches.match(request);
    if (cached) {
      if (shouldRevalidateRuntime(request)) {
        mochiFetch(request, realUrl, MOCHI_TIMEOUT_MS)
          .then((fresh) => {
            if (fresh && fresh.ok) {
              if (responseFitsCache(fresh)) {
                caches.open(RUNTIME_CACHE).then((cache) => {
                  cache.put(request, fresh);
                  capCache(RUNTIME_CACHE, MAX_RUNTIME);
                });
              }
            }
          })
          .catch(() => {});
      }
      return cached;
    }
    const networkFetch = mochiFetch(request, realUrl, MOCHI_TIMEOUT_MS);
    const mochiResponse = await networkFetch;
    if (mochiResponse && mochiResponse.ok) {
      if (responseFitsCache(mochiResponse)) {
        const clone = mochiResponse.clone();
        caches.open(RUNTIME_CACHE).then((cache) => {
          cache.put(request, clone);
          capCache(RUNTIME_CACHE, MAX_RUNTIME);
        });
      }
      return mochiResponse;
    }
  } catch {}
  return null;
}

async function handleRivetNetworkRequest(request, targetUrl) {
  const response = await mochiFetch(request, targetUrl, MOCHI_TIMEOUT_MS);
  if (!response) {
    return new Response(
      swNegativeMessage("rivet extension network request failed"),
      {
        status: 502,
      },
    );
  }

  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get("Origin") || self.location.origin;
  headers.set("Access-Control-Allow-Origin", requestOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Expose-Headers", "*");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  const rivetNetworkUrl = rivetRouter?.extensionNetworkUrl?.(event);
  if (rivetNetworkUrl) {
    event.respondWith(handleRivetNetworkRequest(request, rivetNetworkUrl));
    return;
  }

  if (rivetRouter?.shouldRoute(event)) {
    event.respondWith(
      rivetRouter.route(event).catch((error) => {
        console.error("rivet service-worker route failed:", error, NEGATIVE);
        return new Response(
          swNegativeMessage("rivet extension request failed"),
          {
            status: 502,
          },
        );
      }),
    );
    return;
  }

  if (request.headers.get(PREFETCH_HEADER) === "1") {
    event.respondWith(handlePrefetchProxyRequest(event));
    return;
  }

  const dest = request.destination;
  const isNavigate =
    request.mode === "navigate" ||
    dest === "document" ||
    dest === "iframe" ||
    dest === "frame";
  const url = new URL(request.url);

  const realUrl = unwrapUrl(url);

  if (url.pathname.startsWith(MOCHI_PREFIX)) {
    if (request.method !== "GET") return;
    let afterPrefix = url.pathname.slice(MOCHI_PREFIX.length);
    if (afterPrefix.endsWith("/")) afterPrefix = afterPrefix.slice(0, -1);
    if (afterPrefix.startsWith("http")) return;
    let decodedUrl = null;
    try {
      let base64 = afterPrefix.replace(/-/g, "+").replace(/_/g, "/");
      while (base64.length % 4) base64 += "=";
      const raw = atob(base64);
      const decoded = _adXorDec(raw);
      const result = decodeURIComponent(decoded);
      if (result.startsWith("http")) decodedUrl = result;
    } catch {}
    if (decodedUrl) {
      return event.respondWith(
        (async () => {
          try {
            const response = await mochiFetch(
              request,
              decodedUrl,
              MOCHI_TIMEOUT_MS,
            );
            if (response && response.ok) {
              return response;
            }
            return (
              response ||
              new Response(swNegativeMessage("not found"), { status: 404 })
            );
          } catch {
            return new Response(swNegativeMessage("request failed"), {
              status: 502,
            });
          }
        })(),
      );
    }
    return;
  }

  if (realUrl && realUrl.startsWith("http") && isLargeFile(realUrl, request)) {
    return event.respondWith(handleLargeFile(request, realUrl));
  }

  if (realUrl && realUrl.includes("/!!/")) {
    const parts = realUrl.split("/!!/");
    const target = parts.pop();
    if (target && target.startsWith("http")) {
      return event.respondWith(
        (async () => {
          const response = await mochiFetch(request, target, MOCHI_TIMEOUT_MS);
          return (
            response ||
            new Response(swNegativeMessage("gateway timeout"), { status: 504 })
          );
        })(),
      );
    }
  }

  event.respondWith(
    (async () => {
      try {
        const preloadPromise =
          event.preloadResponse &&
          typeof event.preloadResponse.then === "function"
            ? event.preloadResponse.catch(() => null)
            : Promise.resolve(null);

        if (realUrl && realUrl.startsWith("http")) {
          const cacheHit = await handleCacheableCrossOrigin(
            request,
            url,
            realUrl,
          );
          if (cacheHit) return cacheHit;
        }

        if (isFolio) {
          if (isUnreadableFolioRoute(url))
            return staleFolioRouteResponse(isNavigate);
          await ensureFolioConfig();
          const isFolioRoute = url.pathname === FOLIO_PATH;
          let shouldRoute =
            typeof folio.shouldRoute === "function"
              ? folio.shouldRoute(event)
              : !!folio.route(event);
          if (!shouldRoute && isFolioRoute) {
            await reviveFolioRoutes();
            shouldRoute =
              typeof folio.shouldRoute === "function"
                ? folio.shouldRoute(event)
                : !!folio.route(event);
          }
          if (shouldRoute) {
            return await runProxyEngine(
              folio,
              event,
              request,
              url,
              realUrl,
              isNavigate,
            );
          }
          if (isFolioRoute) {
            return await folioRouteMissFallback(
              request,
              url,
              realUrl,
              isNavigate,
            );
          }
        }

        if (url.origin === self.location.origin && request.method === "GET") {
          return await handleLocalOriginGet(
            event,
            request,
            url,
            preloadPromise,
          );
        }

        return new Response(swNegativeMessage("request forbidden"), {
          status: 403,
        });
      } catch {
        if (realUrl && !realUrl.includes(self.location.host)) {
          const mf = await mochiFetch(request, realUrl, MOCHI_TIMEOUT_MS);
          if (mf) return patchHtml(mf, realUrl);
        }
        const fallback = await caches.match(request);
        if (fallback) return fallback;
        return new Response(swNegativeMessage("request failed"), {
          status: 500,
        });
      }
    })(),
  );
});
