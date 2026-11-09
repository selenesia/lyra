import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { extensionUserAgent } from "../packages/rivet/src/htmlInject.ts";

const NEGATIVE = "... /ᐠ - ˕ -マ";
const POSITIVE = "!! (˵◝ ⩊  ◜˵マ";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionsDir = path.join(root, "packages", "rivet", "extensions");
const crxPath = path.join(extensionsDir, "ublock.crx");
const stateProfiles = [
  { name: "chromium", filename: "ublock.state.gz" },
  {
    name: "firefox",
    filename: "ublock.firefox.state.gz",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  },
];
const appUrl = new URL(process.env.LYRA_APP_URL || "http://localhost:4444/");
const MOCHI_KEY = "q7Zx!9pL";
const LIST_MIRRORS = [
  [
    "https://filters.adtidy.org/extension/ublock/filters/",
    "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/",
  ],
];
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function failure(message) {
  return new Error(`${message}${NEGATIVE}`);
}

async function readBundledUblock() {
  const buffer = await readFile(crxPath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const zipStart =
    buffer.subarray(0, 4).toString() === "Cr24" ? 12 + view.getUint32(8, true) : 0;
  const zip = await JSZip.loadAsync(buffer.subarray(zipStart));
  const read = async (name) => JSON.parse(await zip.file(name).async("text"));
  const manifest = await read("manifest.json");
  return { version: manifest.version, assets: await read("assets/assets.json"), zip };
}

function withMirrors(urls) {
  return [
    ...urls,
    ...urls.flatMap((url) =>
      LIST_MIRRORS.filter(([prefix]) => url.startsWith(prefix)).map(
        ([prefix, mirror]) => mirror + url.slice(prefix.length),
      ),
    ),
  ];
}

function remoteAssets(assets) {
  return Object.entries(assets).flatMap(([key, asset]) => {
    const filters = asset.content === "filters" && asset.off !== true;
    if (!filters && asset.content !== "internal") return [];
    const sources = [asset.contentURL, asset.cdnURLs].flat().filter((url) => typeof url === "string");
    const urls = sources.filter((url) => /^https?:\/\//.test(url)).map((url) => new URL(url).href);
    const bundled = sources.find((url) => !/^https?:\/\//.test(url));
    return urls.length ? [{ key, urls, bundled, required: filters }] : [];
  });
}

async function download(urls) {
  for (const url of withMirrors(urls)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const text = response.ok ? await response.text() : "";
      if (text.trim()) return text;
    } catch {}
  }
  return null;
}

async function prefetchAssets(assets, zip) {
  const responses = new Map();
  const pending = remoteAssets(assets);
  while (pending.length) {
    await Promise.all(
      pending.splice(0).map(async ({ key, urls, bundled, required }) => {
        const bundledText = bundled ? await zip.file(bundled)?.async("text") : undefined;
        const text = bundledText || (await download(urls));
        if (!text) {
          if (required) throw failure(`filter list ${key} could not be downloaded`);
          console.log(`could not download ${key}, lyra will fetch it`);
          return;
        }
        console.log(`${bundledText ? "bundled" : "downloaded"} ${key} (${text.length} chars)`);
        for (const url of urls) responses.set(url, text);
        for (const include of new Set([...text.matchAll(/^!#include\s+(\S+)/gm)].map((match) => match[1]))) {
          const includeUrls = [...new Set(urls.map((url) => new URL(include, url).href))].filter(
            (url) => !responses.has(url),
          );
          if (includeUrls.length) pending.push({ key: `${key} ${include}`, urls: includeUrls, required });
        }
      }),
    );
  }
  return responses;
}

function regionalSelectors(assets, userAgent) {
  const languages = new Set();
  const agents = new Set();
  for (const asset of Object.values(assets)) {
    if (asset.content !== "filters" || asset.off !== true) continue;
    if (typeof asset.lang === "string")
      for (const language of asset.lang.split(/\s+/)) if (language) languages.add(language);
    if (typeof asset.ua === "string") agents.add(asset.ua);
  }
  const matchesAgent = (agent) =>
    new RegExp(`\\b${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(userAgent);
  return {
    regionalLanguages: [...languages].sort(),
    regionalAgents: [...agents].filter((agent) => !matchesAgent(agent)).sort(),
  };
}

function decodeMochiTarget(encoded) {
  const binary = Buffer.from(encoded, "base64url").toString("latin1");
  let decoded = "";
  for (let index = 0; index < binary.length; index++) {
    decoded += String.fromCharCode(
      binary.charCodeAt(index) ^ MOCHI_KEY.charCodeAt(index % MOCHI_KEY.length),
    );
  }
  return decodeURIComponent(decoded);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(200);
  }
  throw failure(message);
}

async function launchChrome(profileDir, userAgent) {
  const executable = CHROME_PATHS.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw failure("chrome was not found, set CHROME_PATH");
  const chrome = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--lang=en-US",
      "--window-size=1280,800",
      "--disable-features=DocumentIsolationPolicy",
      ...(userAgent ? [`--user-agent=${userAgent}`] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const [port, browserPath] = await waitFor(
    async () =>
      existsSync(portFile) ? (await readFile(portFile, "utf8")).trim().split("\n") : null,
    15_000,
    "chrome did not open its debugging port",
  );
  return { chrome, endpoint: `ws://127.0.0.1:${port}${browserPath}` };
}

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(failure("chrome closed the devtools connection"));
    pending.clear();
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(failure(`devtools request failed: ${message.error.message}`));
      else resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
    }
  });
  return {
    socket,
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
  };
}

const BACKGROUND_WINDOW = `(() => {
  for (const frame of document.querySelectorAll("iframe[sandbox]")) {
    try { if (frame.contentWindow?.µBlock) return frame.contentWindow; } catch {}
  }
  return null;
})()`;

const ublockModule = (file) => `(() => {
  const background = ${BACKGROUND_WINDOW};
  const start = [...background.document.querySelectorAll("script[src]")].map((script) => script.src).find((src) => src.endsWith("/js/start.js"));
  return background.eval("import(" + JSON.stringify(new URL(${JSON.stringify(file)}, start).href) + ")");
})()`;

const UPDATE_LISTS = `(async () => {
  const assets = (await ${ublockModule("assets.js")}).default;
  const ub = ${BACKGROUND_WINDOW}.µBlock;
  const finished = new Promise((resolve) => {
    assets.addObserver((topic, details) => {
      if (topic !== "after-assets-updated") return;
      resolve(Promise.resolve(details.assetKeys.length ? ub.loadFilterLists() : null).then(() => details.assetKeys));
    });
  });
  ub.scheduleAssetUpdater({ now: true, fetchDelay: 0 });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("update timed out")), 60000));
  return JSON.stringify(await Promise.race([finished, timeout]));
})()`;

const SAVE_CACHE_REGISTRY = `(async () => {
  const assets = (await ${ublockModule("assets.js")}).default;
  await assets.toCache("lyra-state-flush", "flush");
  await assets.remove("lyra-state-flush");
  return true;
})()`;

const EXPORT_STORAGE = `(async () => {
  const background = ${BACKGROUND_WINDOW};
  const extension = window.Lyra.rivet.getInstalledExtensions().find((entry) => entry.name === "uBlock Origin");
  const s14e = await ${ublockModule("s14e-serializer.js")};
  const prefix = extension.id + "/local/";
  const entries = await new Promise((resolve, reject) => {
    const request = indexedDB.open("rivet_extensions");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const rows = [];
      const range = IDBKeyRange.bound(prefix, extension.id + "/local0", false, true);
      const cursor = request.result.transaction("extension_storage").objectStore("extension_storage").openCursor(range);
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) return resolve(rows);
        rows.push([String(cursor.result.key).slice(prefix.length), cursor.result.value]);
        cursor.result.continue();
      };
    };
  });
  const storage = {};
  const compiled = [];
  for (const [key, value] of entries) {
    if (key.startsWith("cache/compiled/")) compiled.push(key.slice("cache/compiled/".length));
    const shipped =
      !key.startsWith("cache/") ||
      key.startsWith("cache/compiled/") ||
      (key.startsWith("cache/selfie/") && !key.startsWith("cache/selfie/static"));
    if (!shipped) continue;
    const serialized = typeof value === "string" && s14e.isSerialized(value);
    if (key === "assetCacheRegistry" && serialized) storage[key] = s14e.deserialize(value);
    else if (serialized && s14e.isCompressed(value)) storage[key] = s14e.serialize(s14e.deserialize(value), { compress: false });
    else storage[key] = value;
  }
  window.__lyraUblockState = JSON.stringify({
    storage,
    compiled,
    flavor: [...background.vAPI.webextFlavor.soup],
    language: /^[a-z]+/.exec(background.navigator.language || "en")?.[0] ?? "",
  });
  return window.__lyraUblockState.length;
})()`;

async function compileState(profile, bundled, responses) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "lyra-ublock-state-"));
  const { chrome, endpoint } = await launchChrome(profileDir, profile.userAgent);
  let devtools;
  try {
    devtools = await connect(endpoint);
    const { send, on } = devtools;
    const { userAgent: headlessAgent } = await send("Browser.getVersion");
    const userAgent = profile.userAgent ?? headlessAgent.replace("HeadlessChrome", "Chrome");
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await Promise.race([
        send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
        Bun.sleep(150_000).then(() => {
          throw failure("page script timed out");
        }),
      ]);
      if (exceptionDetails) throw failure(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value;
    };

    const unprepared = new Set();
    on("Fetch.requestPaused", ({ requestId, request }) => {
      const url = new URL(request.url);
      if (stateProfiles.some(({ filename }) => url.pathname.endsWith(`/${filename}`))) {
        void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
        return;
      }
      const encoded = /\/!!\/([^/]+)\//.exec(url.pathname)?.[1];
      let target = "";
      try {
        const decoded = new URL(decodeMochiTarget(encoded ?? ""));
        decoded.searchParams.delete("_");
        target = decoded.href;
      } catch {}
      const text = responses.get(target);
      if (text === undefined) {
        if (target) unprepared.add(target);
        void send("Fetch.continueRequest", { requestId }).catch(() => {});
        return;
      }
      void send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
        body: Buffer.from(text).toString("base64"),
      }).catch(() => {});
    });

    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/!!/*", requestStage: "Request" },
        ...stateProfiles.map(({ filename }) => ({
          urlPattern: `*/${filename}*`,
          requestStage: "Request",
        })),
      ],
    });
    await send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: "en-US,en" }, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url: appUrl.href }, sessionId);

    await waitFor(
      () => evaluate(`Boolean(document.getElementById("searchInput"))`),
      30_000,
      "lyra did not finish loading",
    );
    console.log(`compiling ublock origin for ${profile.name}`);
    await evaluate(`document.getElementById("searchInput").dispatchEvent(new MouseEvent("mouseenter"))`);
    await waitFor(
      () => evaluate(`Boolean(${BACKGROUND_WINDOW}?.µBlock.readyToFilter)`),
      90_000,
      "ublock origin did not finish compiling its filter lists",
    );

    console.log("updating ublock origin filter lists");
    const updated = JSON.parse(await evaluate(UPDATE_LISTS));
    console.log(`updated ${updated.length} assets`);
    if (unprepared.size) console.log(`fetched through lyra: ${[...unprepared].join(", ")}`);
    const selected = JSON.parse(
      await evaluate(`(() => {
        const ub = ${BACKGROUND_WINDOW}.µBlock;
        return JSON.stringify(ub.selectedFilterLists.filter((key) => key !== ub.userFiltersPath));
      })()`),
    );

    await evaluate(SAVE_CACHE_REGISTRY);

    console.log("exporting ublock origin state");
    const length = await evaluate(EXPORT_STORAGE);
    let serializedState = "";
    for (let offset = 0; offset < length; offset += 8_000_000) {
      serializedState += await evaluate(`window.__lyraUblockState.slice(${offset}, ${offset + 8_000_000})`);
    }
    const exported = JSON.parse(serializedState);
    const missing = selected.filter((key) => !exported.compiled.includes(key));
    if (missing.length) throw failure(`filter lists did not compile: ${missing.join(", ")}`);
    const registry = exported.storage.assetCacheRegistry ?? {};
    const undated = selected.filter((key) => !(registry[key]?.writeTime > 0));
    if (undated.length) throw failure(`filter lists have no download time: ${undated.join(", ")}`);
    for (const key of [
      "version",
      "selectedFilterLists",
      "assetCacheRegistry",
      "cache/selfie/public_suffix_list.dat",
    ]) {
      if (!(key in exported.storage)) throw failure(`exported ublock origin state is missing ${key}`);
    }
    const expectedFlavor = ["ublock", "webext", "ipaddress", "native_css_has", "chromium"];
    if (exported.flavor.toSorted().join() !== expectedFlavor.toSorted().join())
      throw failure(`ublock origin did not compile for the ${profile.name} runtime`);

    const state = {
      version: bundled.version,
      createdAt: Date.now(),
      flavor: exported.flavor,
      language: exported.language,
      ...regionalSelectors(bundled.assets, extensionUserAgent(userAgent)),
      storage: exported.storage,
    };
    const compressed = gzipSync(JSON.stringify(state), { level: 9 });
    return { profile, compressed, listCount: selected.length };
  } finally {
    devtools?.socket.close();
    chrome.kill();
    await new Promise((resolve) => (chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve)));
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function buildState() {
  const bundled = await readBundledUblock();
  try {
    await fetch(appUrl, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw failure(`lyra is not reachable at ${appUrl.href}, start it with bun run dev:web`);
  }
  const responses = await prefetchAssets(bundled.assets, bundled.zip);
  const states = [];
  for (const profile of stateProfiles)
    states.push(await compileState(profile, bundled, responses));
  for (const { profile, compressed, listCount } of states) {
    await writeFile(path.join(extensionsDir, profile.filename), compressed);
    console.log(
      `ublock origin ${bundled.version} ${profile.name} state saved with ${listCount} lists (${(compressed.length / 1e6).toFixed(1)} mb)${POSITIVE}`,
    );
  }
}

try {
  await buildState();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
