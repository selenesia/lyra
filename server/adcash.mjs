import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { ADCASH_LIBRARY_PATH, adcashEmbedderPolicy } from "../src/core/runtime/adcash.ts";
import { negativeMessage } from "../src/core/runtime/messages.ts";

export { ADCASH_LIBRARY_PATH, adcashEmbedderPolicy };
const LIBRARY_URL = "https://adbpage.com/adblock?v=3&format=js";
const REFRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const JS_HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "cross-origin",
  Vary: "Accept-Encoding",
};

const BUILD_MODULE = fileURLToPath(new URL("../build.js", import.meta.url));

function bootstrapSource(loadingFlag) {
  const flag = JSON.stringify(loadingFlag);
  return `(function(){if(window.top!==window.self||window[${flag}])return;window[${flag}]=true;var library=document.createElement("script");library.async=true;library.src=${JSON.stringify(ADCASH_LIBRARY_PATH)};document.head.appendChild(library);})();`;
}

function createBootstrap(logger) {
  const source = bootstrapSource(`x${randomBytes(10).toString("hex")}`);
  const prefix = `x${randomBytes(5).toString("hex")}`;
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { obfuscateSource, RUNTIME_OBFUSCATION_OPTIONS } = await import(${JSON.stringify(BUILD_MODULE)});` +
      `process.stdout.write(obfuscateSource(${JSON.stringify(source)}, RUNTIME_OBFUSCATION_OPTIONS, ${JSON.stringify(prefix)}));`,
  ], { stdout: "pipe", stderr: "ignore" });
  const obfuscated = result.success ? result.stdout.toString() : "";
  if (!obfuscated) logger.warn(negativeMessage("[adcash] loader obfuscation failed; serving the plain loader"));
  return `<script>${(obfuscated || source).replace(/<\/(script)/gi, "<\\/$1")}</script>`;
}

async function encodeLibrary(source, zone) {
  const raw = Buffer.concat([source, zone]);
  const [br, gz] = await Promise.all([
    brotli(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
    gzip(raw, { level: 6 }),
  ]);
  return { source, raw, br, gzip: gz };
}

export function normalizeAdcashZoneTag(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 64 * 1024) {
    throw new Error(negativeMessage("the adcash zone tag must contain at most 64 kib of javascript"));
  }

  let code = input.trim();
  if (/^<script\b/i.test(code)) {
    const match = /^<script\b([^>]*)>([\s\S]*?)<\/script\s*>$/i.exec(code);
    if (!match || /\bsrc\s*=/i.test(match[1])) {
      throw new Error(negativeMessage("paste only the inline adcash zone script"));
    }
    code = match[2].trim();
  }
  if (!code || /<\/?script\b/i.test(code)) {
    throw new Error(negativeMessage("only one inline adcash zone script is supported"));
  }

  try {
    new Function(code);
  } catch {
    throw new Error(negativeMessage("the adcash zone script contains invalid javascript"));
  }
  return code;
}

export function createAdcash({
  root = process.cwd(),
  fetchImpl = fetch,
  now = Date.now,
  logger = console,
  tagFile = path.join(root, ".adcash-zone.tag"),
  cacheFile = path.join(root, "cache", "adcash-lib.js"),
} = {}) {
  let zone;
  try {
    zone = normalizeAdcashZoneTag(fs.readFileSync(tagFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn(negativeMessage("[adcash] invalid zone tag; ads disabled"));
    }
    return {
      enabled: false,
      injectHtml: (html) => html,
      handle: (req, pathname) => pathname === ADCASH_LIBRARY_PATH
        ? new Response(null, { status: 204, headers: JS_HEADERS })
        : null,
    };
  }

  const zoneCall = Buffer.from("\n;(function () {\nif (!window.aclib) return;\n" + zone + "\n})();\n");
  const bootstrap = createBootstrap(logger);
  let cached = null;
  let freshUntil = 0;
  let retryAt = 0;
  let pending = null;

  let previous;
  try {
    previous = fs.readFileSync(cacheFile);
    freshUntil = fs.statSync(cacheFile).mtimeMs + REFRESH_MS;
  } catch {
    previous = null;
  }
  if (previous?.toString("utf8").trim() && previous.byteLength <= MAX_LIBRARY_BYTES) {
    cached = { source: previous, raw: Buffer.concat([previous, zoneCall]) };
    encodeLibrary(previous, zoneCall)
      .then((entry) => { if (cached?.source === previous) cached = entry; })
      .catch(() => {});
  }

  async function download() {
    try {
      const response = await fetchImpl(LIBRARY_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok || /text\/html/i.test(response.headers.get("content-type") || "")) {
        throw new Error(negativeMessage("upstream did not return javascript"));
      }
      const claimedLength = Number(response.headers.get("content-length") || 0);
      if (claimedLength > MAX_LIBRARY_BYTES) throw new Error(negativeMessage("library is too large"));
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > MAX_LIBRARY_BYTES) {
          throw new Error(negativeMessage("library is too large"));
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!raw.toString("utf8").trim()) {
        throw new Error(negativeMessage("library is empty"));
      }

      cached = await encodeLibrary(raw, zoneCall);
      freshUntil = now() + REFRESH_MS;
      retryAt = 0;
      const tempFile = cacheFile + "." + process.pid + ".tmp";
      try {
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(tempFile, raw, { mode: 0o600 });
        await rename(tempFile, cacheFile);
      } catch {
        await unlink(tempFile).catch(() => {});
        logger.warn(negativeMessage("[adcash] cannot persist library cache"));
      }
      return cached;
    } catch {
      retryAt = now() + RETRY_MS;
      logger.warn(negativeMessage("[adcash] library refresh failed; using cached copy if present"));
      return cached;
    }
  }

  function refresh() {
    pending ??= download().finally(() => { pending = null; });
    return pending;
  }

  function library() {
    const time = now();
    if (time < retryAt) return cached;
    if (cached) {
      if (time >= freshUntil) refresh();
      return cached;
    }
    return refresh();
  }

  return {
    enabled: true,
    injectHtml(html) {
      return html.replace(/<\/head\s*>/i, () => bootstrap + "\n</head>");
    },
    async handle(req, pathname) {
      if (pathname !== ADCASH_LIBRARY_PATH) return null;
      const entry = await library();
      if (!entry) {
        return new Response(null, { status: 503, headers: { ...JS_HEADERS, "Retry-After": "60" } });
      }
      const accept = req.headers.get("accept-encoding") || "";
      const encoding = entry.br && accept.includes("br") ? "br" : entry.gzip && accept.includes("gzip") ? "gzip" : null;
      return new Response(req.method === "HEAD" ? null : encoding ? entry[encoding] : entry.raw, {
        status: 200,
        headers: {
          ...JS_HEADERS,
          "Cache-Control": "max-age=300",
          ...(encoding ? { "Content-Encoding": encoding } : {}),
        },
      });
    },
  };
}
