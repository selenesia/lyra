const STATIC_BASE = "__STATIC_BASE__";
const STATIC_GATEWAY = globalThis.__LYRA_BACKEND__ + "/api/static/v1/";
const staticParents = new Map();
let staticLastRecovery = 0;
let staticLastBackendFailure = 0;
const staticNetworkFetch = globalThis.fetch.bind(globalThis);
const staticBackendAbort = new AbortController();

self.addEventListener("message", (event) => {
  if (event.data?.type !== "static-retire" || !staticAppClient(event.source)) return;
  const waiting = self.registration.waiting;
  if (!waiting || waiting.scriptURL !== event.data.worker) return;
  const replacement = new URL(waiting.scriptURL);
  const current = new URL(self.location.href);
  if (replacement.origin !== current.origin || !replacement.pathname.startsWith(STATIC_BASE) ||
      replacement.href === current.href) return;
  staticBackendAbort.abort();
});
const staticRequestHeaders = new Set([
  "accept", "accept-language", "content-type", "range", "if-range", "if-none-match",
  "if-modified-since", "cache-control", "x-mochi-folio-headers", "x-mochi-folio-session",
]);

function staticPath(url) {
  return STATIC_BASE !== "/" && url.pathname.startsWith(STATIC_BASE)
    ? "/" + url.pathname.slice(STATIC_BASE.length) : url.pathname;
}

function staticAppClient(client) {
  if (!client || client.type !== "window") return false;
  const url = new URL(client.url);
  return url.origin === self.location.origin && url.pathname.startsWith(STATIC_BASE) && ["/", "/index.html", "/s"].includes(staticPath(url));
}

async function staticSigner(event) {
  const clientId = event?.clientId || "";
  const client = clientId ? await self.clients.get(clientId) : null;
  if (staticAppClient(client)) return client;
  const parent = staticParents.get(clientId);
  if (parent) {
    const owner = await self.clients.get(parent);
    if (staticAppClient(owner)) return owner;
    staticParents.delete(clientId);
  }
  return (await self.clients.matchAll({ type: "window" })).find(staticAppClient) || null;
}

async function staticProof(url, method, event, renew = false) {
  const client = await staticSigner(event);
  if (!client) return null;
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 15_000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(data && typeof data.authorization === "string" && typeof data.dpop === "string" ? data : null);
    };
    client.postMessage({ type: "static-sign", url, method, renew }, [channel.port2]);
  });
}

function staticBackendFailure() {
  if (Date.now() - staticLastBackendFailure < 5_000) return;
  staticLastBackendFailure = Date.now();
  void self.clients.matchAll({ type: "window" }).then((clients) => {
    for (const client of clients) if (staticAppClient(client)) client.postMessage({ type: "static-backend-unavailable" });
  });
}

function staticBackendPath(path) {
  return /^\/(?:api\/|!!(?:raw|folio)?\/|!cover!\/|stream\/)/.test(path);
}

async function staticForward(request, event) {
  if (staticBackendAbort.signal.aborted) return new Response(null, { status: 503 });
  const source = new URL(request.url);
  const path = staticPath(source);
  const ticket = path === "/__static/ticket";
  const metadata = path === "/api/stuff";
  if (/^\/api\/(?:auth|sync)\//.test(path)) return Response.json({
    error: "account features require the production site... /ᐠ - ˕ -マ", code: "static_account_unavailable",
  }, { status: 403, headers: { "cache-control": "no-store" } });
  const destination = STATIC_GATEWAY + (ticket ? "ticket" : metadata ? "metadata" : "http" + path) + source.search;
  const method = ticket ? "POST" : request.method;
  const signed = await staticProof(destination, method, event);
  if (!signed) return new Response("connection unavailable... /ᐠ - ˕ -マ", { status: 401, headers: { "cache-control": "no-store" } });
  const headers = new Headers();
  for (const [name, value] of request.headers) if (staticRequestHeaders.has(name)) headers.set(name, value);
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  let body;
  if (!["GET", "HEAD"].includes(method) && request.body) {
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 10 * 1024 * 1024) {
        await reader.cancel();
        return new Response("request is too large... /ᐠ - ˕ -マ", { status: 413 });
      }
      chunks.push(chunk.value);
    }
    body = new Blob(chunks);
  }
  const send = async () => {
    try {
      const response = await staticNetworkFetch(destination, { method, headers, body, credentials: "omit", redirect: "error",
        cache: "no-store", signal: AbortSignal.any([request.signal, staticBackendAbort.signal]) });
      if (response.status === 503) staticBackendFailure();
      return response;
    } catch (error) {
      if (!request.signal.aborted && !staticBackendAbort.signal.aborted) staticBackendFailure();
      throw error;
    }
  };
  let response = await send();
  if (response.status === 401 && response.headers.get("x-static-auth") === "required") {
    const renewed = await staticProof(destination, method, event, true);
    if (renewed) {
      await response.body?.cancel();
      for (const [name, value] of Object.entries(renewed)) headers.set(name, value);
      response = await send();
    }
  }
  if (metadata && response.ok) {
    const metadata = await response.json();
    const local = await staticNetworkFetch(STATIC_BASE + "build-meta.json", { cache: "no-store" }).then((result) => result.json());
    return Response.json({ ...metadata, build: local.build, version: local.version }, { headers: { "cache-control": "no-store" } });
  }
  const resultHeaders = new Headers(response.headers);
  resultHeaders.delete("content-encoding");
  return staticIsolatedResponse(new Response(response.body, { status: response.status, headers: resultHeaders }));
}

const fetch = (input, init) => {
  const request = new Request(typeof input === "string" ? new URL(input, self.location.origin) : input, init);
  const url = new URL(request.url);
  if (url.origin === self.location.origin && staticBackendPath(staticPath(url))) return staticForward(request);
  return staticNetworkFetch(request);
};

async function staticDocument(request, file) {
  const response = staticIsolatedResponse(await staticNetworkFetch(new URL(STATIC_BASE + file, self.location.origin), { cache: "no-cache", signal: request.signal }));
  const browser = /\b(Chrome|Firefox)\/(\d+)/.exec(self.navigator?.userAgent || "");
  if (browser && Number(browser[2]) >= (browser[1] === "Chrome" ? 96 : 119)) {
    response.headers.set("cross-origin-embedder-policy", "credentialless");
  }
  return response;
}

function staticIsolatedResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(staticNetworkFetch(request));
    return;
  }
  if (request.mode === "navigate" && !url.pathname.startsWith(STATIC_BASE)) {
    event.respondWith(staticNetworkFetch(request));
    return;
  }
  const path = staticPath(url);
  if (path === "/__static/recover" && request.method === "POST") {
    event.respondWith((async () => {
      if (Date.now() - staticLastRecovery >= 1_000) {
        staticLastRecovery = Date.now();
        for (const client of await self.clients.matchAll({ type: "window" })) {
          if (staticAppClient(client)) client.postMessage({ type: "static-transport-closed" });
        }
      }
      return new Response(null, { status: 204 });
    })());
    return;
  }
  if (path === "/__static/socket.js") {
    event.respondWith(new Response(STATIC_SOCKET_SOURCE, { headers: {
      "content-type": "application/javascript", "cache-control": "no-cache",
      "cross-origin-resource-policy": "same-origin",
    } }));
    return;
  }
  if (event.resultingClientId && event.clientId) {
    if (staticParents.size >= 1_000) staticParents.delete(staticParents.keys().next().value);
    staticParents.set(event.resultingClientId, staticParents.get(event.clientId) || event.clientId);
  }
  if (request.mode === "navigate" && ["/", "/index.html", "/s", "/player.html", "/stream/anime", "/stream/watch"].includes(path)) {
    event.respondWith(staticDocument(request, ["/player.html", "/stream/anime", "/stream/watch"].includes(path) ? "player.html" : "index.html"));
    return;
  }
  if (path === "/__static/ticket" || /^\/(?:api\/|stream\/|!!raw\/|!!folio\/|!cover!\/)/.test(path) ||
      (path.startsWith("/!!/") && (path.slice(4).startsWith("http") || request.method !== "GET"))) {
    event.respondWith(staticForward(request, event).catch(() => new Response("connection unavailable... /ᐠ - ˕ -マ", { status: 502 })));
    return;
  }
  if (STATIC_BASE !== "/" && !url.pathname.startsWith(STATIC_BASE) && /^\/(?:assets|b|bmux|epoxy|libcurl)\//.test(path)) {
    url.pathname = STATIC_BASE + path.slice(1);
    event.respondWith(staticNetworkFetch(new Request(url, request)));
  }
});
