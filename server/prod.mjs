import fs from "fs";
import net from "net";
import path from "path";
import { availableParallelism, totalmem } from "os";
import { httpError } from "./errors.mjs";
import { createDnsService } from "./dns.mjs";
import { createPresence } from "./presence.mjs";
import { createNoticeBoard, noticeSocketPath } from "./notice.mjs";
import { startChat } from "./chat-service.mjs";
import { turnConfig } from "./turn.mjs";
import {
  negativeMessage,
  positiveMessage,
} from "../src/core/runtime/messages.ts";
import { createSearchSuggestionService } from "./search-suggestions.mjs";
import { allowMetrics, createMetrics } from "./metrics.mjs";
import { createSourceBuildId } from "../build-id.mjs";
import { productionStaticGateway } from "./static-backend.mjs";
import { ADCASH_LIBRARY_PATH, adcashEmbedderPolicy, createAdcash } from "./adcash.mjs";
import {
  distCacheControl,
  IMMUTABLE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
} from "./cache.mjs";

let shuttingDown = false;
const ROOT = process.cwd();
const notices = createNoticeBoard();
const connectPresence = createPresence({ maxStreamsPerSource: 1_000, broadcastMs: 1_000, greet: notices.greet });
const stopNotices = notices.serve({ presence: connectPresence, socketPath: noticeSocketPath(ROOT) });
const chat = startChat({ root: ROOT });
const adcash = createAdcash({ root: ROOT });
const PORT = Number.parseInt(process.env.PORT || "4444", 10);
const TURN_HEALTH_HOST = process.env.TURN_HEALTH_HOST || "127.0.0.1";
const TURN_HEALTH_PORT = Number.parseInt(process.env.TURN_PORT || "3478", 10);
const TURN_HEALTH_TIMEOUT_MS = 2_000;
const packageJsonPath = path.join(ROOT, "package.json");
const distPath = path.join(ROOT, "dist");
const publicPath = path.join(ROOT, "public");
const baremuxPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "bare-mux",
  "dist",
);
const epoxyPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "epoxy-transport",
  "dist",
);
const libcurlPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "libcurl-transport",
  "dist",
);

const MOCHI_PROXY_TIMEOUT_MS = 70_000;
const MOCHI_PROXY_PATHS = [
  "/!!/",
  "/!!raw/",
  "/!!folio/",
  "/!cover!/",
  "/stream/",
];
const MOCHI_ORIGIN = (() => {
  try {
    return new URL(
      process.env.MOCHI_ORIGIN ||
        `http://127.0.0.1:${process.env.MOCHI_PORT || "4000"}`,
    );
  } catch {
    return new URL("http://127.0.0.1:4000");
  }
})();
const API_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const HOST_CORES = Math.max(1, availableParallelism());
const HOST_MEMORY_BYTES = Math.max(256 * 1024 * 1024, totalmem());
const API_LIMIT_MAX = Math.max(0, Number.parseInt(process.env.LYRA_API_LIMIT_MAX || "", 10) || 0) || HOST_CORES * 250;
const API_LIMIT_MAX_CLIENTS = Math.max(
  2_000,
  Math.floor(HOST_MEMORY_BYTES / (1024 * 1024)) * 8,
);
const apiHits = new Map();
const searchSuggestionService = createSearchSuggestionService();
const metrics = createMetrics();
const dnsService = createDnsService();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

const COMPRESSIBLE = /\.(js|css|html|mjs|json|svg|xml|wasm)$/i;
const ENCODING_MAP = [
  { token: "br", ext: ".br" },
  { token: "gzip", ext: ".gz" },
];

let packageData = null;
try {
  packageData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch {}

function turnConfigForRequest(req) {
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().split(":")[0] ||
    req.headers.get("host")?.split(":")[0] ||
    "lyra.lat";
  return turnConfig(host);
}

const buildFingerprint = (() => {
  const fallback = packageData?.version || "unknown";

  for (const dir of ["dist", "src"]) {
    try {
      const metaPath = path.join(ROOT, dir, "build-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (typeof meta.build === "string" && meta.build.length > 0) {
        return meta.build;
      }
    } catch {}
  }

  try {
    return createSourceBuildId(ROOT);
  } catch {
    return fallback;
  }
})();

const staticGateway = productionStaticGateway((backend) => ({
  version: packageData?.version,
  build: buildFingerprint,
  turn: turnConfigForRequest(new Request(backend)),
}));

function baseHeaders(cacheControl, extra = {}) {
  return {
    "Cache-Control": cacheControl,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    ...extra,
  };
}

function contentType(filePath) {
  return (
    MIME_TYPES[path.extname(filePath).toLowerCase()] ||
    "application/octet-stream"
  );
}

function safeJoin(root, pathname, prefix = "") {
  if (
    prefix &&
    pathname !== prefix.slice(0, -1) &&
    !pathname.startsWith(prefix)
  ) {
    return null;
  }

  let rel = prefix ? pathname.slice(prefix.length) : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }

  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.includes("\0") || rel.split("/").includes("..")) return null;

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, rel);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

async function existingFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return null;
    return {
      file: Bun.file(filePath),
      etag: `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`,
      lastModified: stats.mtime.toUTCString(),
    };
  } catch {
    return null;
  }
}

function isNotModified(req, file) {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch) {
    return (
      ifNoneMatch === "*" ||
      ifNoneMatch.split(",").some((value) => value.trim() === file.etag)
    );
  }

  const ifModifiedSince = req.headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const modifiedSince = Date.parse(ifModifiedSince);
  const lastModified = Date.parse(file.lastModified);
  return (
    Number.isFinite(modifiedSince) &&
    Number.isFinite(lastModified) &&
    lastModified <= modifiedSince
  );
}

async function serveFile(req, filePath, cacheControl, options = {}) {
  const accept = req.headers.get("accept-encoding") || "";
  const canPrecompress =
    options.precompressed !== false && COMPRESSIBLE.test(filePath);
  let file;
  let encoding;

  if (canPrecompress) {
    for (const { token, ext } of ENCODING_MAP) {
      if (!accept.includes(token)) continue;
      file = await existingFile(`${filePath}${ext}`);
      if (!file) continue;
      encoding = token;
      break;
    }
  }

  file ??= await existingFile(filePath);
  if (!file) return null;
  const headers = baseHeaders(cacheControl, {
    "Content-Type": options.type || contentType(filePath),
    ...(encoding ? { "Content-Encoding": encoding } : {}),
    ...(canPrecompress ? { Vary: "Accept-Encoding" } : {}),
    ETag: file.etag,
    "Last-Modified": file.lastModified,
    ...options.headers,
  });
  if (
    cacheControl !== NO_STORE_CACHE_CONTROL &&
    (options.status || 200) === 200 &&
    isNotModified(req, file)
  ) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(req.method === "HEAD" ? null : file.file, {
    status: options.status || 200,
    headers: {
      ...headers,
      "Content-Length": String(file.file.size),
    },
  });
}

async function serveMounted(req, pathname, prefix, root, cacheControl) {
  if (pathname === prefix.slice(0, -1) || pathname.endsWith("/")) return null;
  const filePath = safeJoin(root, pathname, prefix);
  if (!filePath) return null;
  return serveFile(req, filePath, cacheControl);
}

async function serveDistFile(req, pathname) {
  if (pathname === "/" || pathname.endsWith("/")) return null;
  const filePath = safeJoin(distPath, pathname);
  if (!filePath) return null;
  return serveFile(req, filePath, distCacheControl(pathname), {
    headers:
      req.headers.get("service-worker") === "script"
        ? { "Service-Worker-Allowed": "/f" }
        : undefined,
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    }),
  });
}

function healthResponse(status = 200) {
  return new Response("oki", {
    status,
    headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
      "Content-Type": "text/plain; charset=utf-8",
    }),
  });
}

function probeEturnal() {
  if (
    !Number.isInteger(TURN_HEALTH_PORT) ||
    TURN_HEALTH_PORT < 1 ||
    TURN_HEALTH_PORT > 65_535
  ) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: TURN_HEALTH_HOST,
      port: TURN_HEALTH_PORT,
    });
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };

    socket.setTimeout(TURN_HEALTH_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function getClientIp(req, server) {
  const peer = server.requestIP(req)?.address || "";
  const loopback =
    peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (loopback) {
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",", 1)[0].trim();
  }
  return peer || "unknown";
}

function rateLimitApi(req, server) {
  const now = Date.now();
  const ip = getClientIp(req, server);
  const state = apiHits.get(ip);

  if (!state || now - state.start > API_LIMIT_WINDOW_MS) {
    if (!state && apiHits.size >= API_LIMIT_MAX_CLIENTS) {
      const oldestIp = apiHits.keys().next().value;
      if (oldestIp !== undefined) apiHits.delete(oldestIp);
    }
    apiHits.set(ip, { start: now, count: 1 });
    return null;
  }

  state.count += 1;
  if (state.count <= API_LIMIT_MAX) return null;

  const failure = httpError(
    429,
    "RATE_LIMITED",
    "too many requests, please try again later",
  );
  return jsonResponse(failure.body, failure.status, {
    "RateLimit-Limit": String(API_LIMIT_MAX),
    "RateLimit-Remaining": "0",
    "RateLimit-Reset": String(
      Math.ceil((state.start + API_LIMIT_WINDOW_MS) / 1000),
    ),
  });
}

setInterval(() => {
  const cutoff = Date.now() - API_LIMIT_WINDOW_MS;
  for (const [ip, state] of apiHits) {
    if (state.start < cutoff) apiHits.delete(ip);
  }
}, API_LIMIT_WINDOW_MS).unref?.();

const RUNTIME_MOUNTS = [true, false].flatMap((versioned) =>
  [
    ["/bmux/", baremuxPath],
    ["/epoxy/", epoxyPath],
    ["/libcurl/", libcurlPath],
  ].map(([prefix, root]) => [
    versioned ? `${prefix}${buildFingerprint}/` : prefix,
    root,
    versioned ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
  ]),
);

async function routeStatic(req, pathname) {
  if (pathname.toLowerCase().endsWith(".map")) return null;
  for (const [prefix, root, cacheControl] of RUNTIME_MOUNTS) {
    const response = await serveMounted(req, pathname, prefix, root, cacheControl);
    if (response) return response;
  }
  return (
    (await serveDistFile(req, pathname)) ||
    (await serveMounted(
      req,
      pathname,
      "/assets/",
      path.join(publicPath, "assets"),
      REVALIDATE_CACHE_CONTROL,
    ))
  );
}

function isMochiPath(pathname) {
  return (
    !pathname.startsWith("/stream/anime") &&
    MOCHI_PROXY_PATHS.some((prefix) => pathname.startsWith(prefix))
  );
}

function hasMochiReferer(req) {
  try {
    return new URL(req.headers.get("referer")).pathname.startsWith("/!!/");
  } catch {
    return false;
  }
}

async function proxyToMochi(req) {
  const upstreamUrl = new URL(req.url);
  upstreamUrl.protocol = MOCHI_ORIGIN.protocol;
  upstreamUrl.host = MOCHI_ORIGIN.host;
  upstreamUrl.username = MOCHI_ORIGIN.username;
  upstreamUrl.password = MOCHI_ORIGIN.password;

  const headers = new globalThis.Headers(req.headers);
  for (const name of [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-host", req.headers.get("host") || "");

  headers.set("accept-encoding", "identity");

  const controller = new AbortController();
  let responseReader;
  let bodyOwnsLifecycle = false;
  const abortRequest = () => {
    controller.abort();
    void responseReader?.cancel().catch(() => {});
  };
  const abortOnDisconnect = () => abortRequest();
  req.signal.addEventListener("abort", abortOnDisconnect, { once: true });
  if (req.signal.aborted) abortOnDisconnect();
  const timeout = setTimeout(abortRequest, MOCHI_PROXY_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", abortOnDisconnect);
  };

  try {
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      signal: controller.signal,
    });
    const responseHeaders = new globalThis.Headers(response.headers);
    for (const name of [
      "connection",
      "content-length",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
    ]) {
      responseHeaders.delete(name);
    }
    responseHeaders.set("x-lyra-proxy", "prod-mochi");

    let body = null;
    if (req.method !== "HEAD" && response.body) {
      responseReader = response.body.getReader();
      body = new globalThis.ReadableStream({
        async pull(streamController) {
          try {
            const { done, value } = await responseReader.read();
            if (done) {
              cleanup();
              streamController.close();
              return;
            }
            streamController.enqueue(value);
            timeout.refresh();
          } catch (error) {
            cleanup();
            streamController.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          await responseReader.cancel(reason).catch(() => {});
        },
      });
    }

    const proxiedResponse = new Response(body, {
      status: response.status,
      headers: responseHeaders,
    });
    bodyOwnsLifecycle = body !== null;
    return proxiedResponse;
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return new Response(
      aborted
        ? negativeMessage("the game proxy timed out; try again shortly")
        : negativeMessage("the game proxy is temporarily unavailable"),
      {
        status: 503,
        headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Lyra-Error-Class": aborted ? "network-timeout" : "infrastructure",
        }),
      },
    );
  } finally {
    if (!bodyOwnsLifecycle) cleanup();
  }
}

async function injectAdcashPage(req, response) {
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cross-Origin-Embedder-Policy", adcashEmbedderPolicy(req.headers.get("user-agent")));
  if (req.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(adcash.injectHtml(await response.text()), { status: 200, headers });
}

async function appFetch(req, server, url) {
  const pathname = url.pathname;

  if (shuttingDown) {
    if (pathname === "/health" || pathname === "/eturnal/health") {
      return healthResponse(503);
    }
    return new Response(negativeMessage("server is shutting down"), {
      status: 503,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
      }),
    });
  }

  const method = req.method;
  const canServeBody = method === "GET" || method === "HEAD";

  if (pathname.startsWith("/api/static/v1/")) {
    return staticGateway.handle(req, { ip: getClientIp(req, server), server });
  }

  if (canServeBody && pathname === ADCASH_LIBRARY_PATH) {
    return adcash.handle(req, pathname);
  }

  if (pathname === "/health" && canServeBody) {
    return healthResponse();
  }

  if (pathname === "/metrics" && canServeBody) {
    if (!allowMetrics(req, server.requestIP(req)?.address, process.env.LYRA_METRICS_TOKEN)) {
      const failure = httpError(403, "FORBIDDEN", "access denied");
      return jsonResponse(failure.body, failure.status);
    }
    return jsonResponse({ ...metrics.snapshot(), suggestions: searchSuggestionService.metrics() });
  }

  if (pathname === "/eturnal/health" && canServeBody) {
    return healthResponse((await probeEturnal()) ? 200 : 503);
  }

  if (isMochiPath(pathname) || hasMochiReferer(req)) return proxyToMochi(req);
  if (pathname === "/api/dns") {
    return rateLimitApi(req, server) || dnsService.handle(req);
  }
  if (pathname === "/api/presence" && method === "GET") {
    const stream = connectPresence(req.signal, url.searchParams.get("id"), getClientIp(req, server));
    if (stream) return stream;
    const failure = httpError(429, "RATE_LIMITED", "too many requests, please try again later");
    return jsonResponse(failure.body, failure.status);
  }
  if (pathname.startsWith("/api/chat/")) {
    return chat.handle(req, { ip: getClientIp(req, server) });
  }
  if (pathname === "/api/notice") {
    const result = await notices.handle(req);
    return jsonResponse(result.body, result.status);
  }

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL),
    });
  }

  if (pathname === "/api/stuff" && method === "GET") {
    if (!packageData) {
      const failure = httpError(
        500,
        "SERVICE_METADATA_UNAVAILABLE",
        "service metadata is unavailable",
      );
      return jsonResponse(failure.body, failure.status);
    }
    return jsonResponse({
      version: packageData.version,
      build: buildFingerprint,
      turn: turnConfigForRequest(req),
    });
  }

  if (pathname === "/api/search/suggestions" && method === "GET") {
    const limited = rateLimitApi(req, server);
    if (limited) return limited;
    const result = await searchSuggestionService(url.searchParams.get("q"));
    return jsonResponse(result.body, result.status);
  }

  if (!canServeBody) {
    return new Response(negativeMessage("method not allowed"), {
      status: 405,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET, HEAD, OPTIONS",
      }),
    });
  }

  const staticResponse = await routeStatic(req, pathname);
  if (staticResponse) return staticResponse;

  if (pathname === "/" || pathname === "/s") {
    const response = await serveFile(
      req,
      path.join(distPath, "index.html"),
      NO_STORE_CACHE_CONTROL,
      { precompressed: !adcash.enabled },
    );
    if (response) return adcash.enabled ? injectAdcashPage(req, response) : response;
  }

  if (pathname === "/stream/anime") {
    const response = await serveFile(
      req,
      path.join(distPath, "player.html"),
      NO_STORE_CACHE_CONTROL,
      { precompressed: !adcash.enabled },
    );
    if (response) return adcash.enabled ? injectAdcashPage(req, response) : response;
  }

  return (
    (await serveFile(
      req,
      path.join(distPath, "404.html"),
      NO_STORE_CACHE_CONTROL,
      {
        status: 404,
        type: "text/html; charset=utf-8",
      },
    )) ||
    new Response(negativeMessage("not found"), {
      status: 404,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
      }),
    })
  );
}

const server = Bun.serve({
  port: PORT,
  hostname: process.env.LYRA_HOST || "127.0.0.1",
  http2: true,
  idleTimeout: 60,
  async fetch(req, server) {
    const started = performance.now();
    const url = new URL(req.url);
    let status = 500;
    try {
      const response = await appFetch(req, server, url);
      status = response?.status || 101;
      return response;
    } finally {
      metrics.record(url.pathname, status, performance.now() - started);
    }
  },
  websocket: staticGateway.websocket,
});

async function gracefulShutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  metrics.close();
  stopNotices();
  chat.close();
  console.log("\nshutting down...");
  server.stop(true);
  console.log(positiveMessage(`port ${PORT} released`));
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("unhandledRejection", (error) => {
  console.error(negativeMessage("unhandled promise rejection"), error);
});

console.log(positiveMessage(`prod server listening on ${server.port}`));
