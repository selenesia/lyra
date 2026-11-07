import { createChromeApi } from "./chromeApi";
import { createContentScriptScope, runInContentScope } from "./contentScope";
import { readExtFileText } from "./fileStore";
import { injectStyle, type NativeDomOperations } from "./htmlInject";
import { urlMatchesPatterns } from "./manifest";
import type { ExtensionState, RivetRegistry } from "./registry";
import type {
  ChromeManifestContentScript,
  ContentScriptAsset,
  ContentScriptRegistration,
  RivetHostBindings,
} from "./types";

function contentScriptAssetKey(extId: string, path: string): string {
  return `${extId}/${path.replace(/^\/+/, "")}`;
}

function cachedContentScriptAsset(
  extId: string,
  asset: ContentScriptAsset,
  registry: RivetRegistry,
): string | null | undefined {
  if (typeof asset === "string") {
    const key = contentScriptAssetKey(extId, asset);
    return registry.contentScriptAssets.has(key)
      ? registry.contentScriptAssets.get(key)
      : undefined;
  }
  if (typeof asset.code === "string") return asset.code;
  if (typeof asset.file === "string") {
    const key = contentScriptAssetKey(extId, asset.file);
    return registry.contentScriptAssets.has(key)
      ? registry.contentScriptAssets.get(key)
      : undefined;
  }
  return null;
}

export async function preloadContentScriptAssets(
  ext: ExtensionState,
  registry: RivetRegistry,
): Promise<void> {
  const assets = new Set<string>();
  for (const script of ext.manifest.content_scripts ?? []) {
    for (const asset of [...(script.js ?? []), ...(script.css ?? [])]) {
      if (typeof asset === "string") assets.add(asset);
    }
  }
  const pending = [...assets].filter(
    (asset) =>
      !registry.contentScriptAssets.has(contentScriptAssetKey(ext.id, asset)),
  );
  for (let offset = 0; offset < pending.length; offset += 8) {
    await Promise.all(
      pending.slice(offset, offset + 8).map(async (asset) => {
        registry.contentScriptAssets.set(
          contentScriptAssetKey(ext.id, asset),
          await readExtFileText(ext.id, asset.replace(/^\/+/, "")),
        );
      }),
    );
  }
}

export function registerContentScripts(
  ext: ExtensionState,
  registry: RivetRegistry,
): void {
  const scripts: ChromeManifestContentScript[] =
    ext.manifest.content_scripts ?? [];
  for (const cs of scripts) {
    registry.contentScripts.push({
      extId: ext.id,
      matches: cs.matches ?? [],
      excludeMatches: cs.exclude_matches ?? [],
      js: cs.js ?? [],
      css: cs.css ?? [],
      runAt: cs.run_at ?? "document_idle",
      allFrames: cs.all_frames ?? false,
    });
  }
}

export function unregisterContentScripts(
  extId: string,
  registry: RivetRegistry,
): void {
  for (let i = registry.contentScripts.length - 1; i >= 0; i--) {
    if (registry.contentScripts[i]?.extId === extId)
      registry.contentScripts.splice(i, 1);
  }
}

function generateDocumentId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2).padEnd(32, "0");
}

interface ContentScriptDocumentContext {
  frameId: number;
  documentId: string;
}

const nextFrameIds = new Map<number, number>();
const frameWindows = new Map<number, Map<number, WeakRef<Window>>>();

function getDocumentContext(
  tabId: number,
  isTopLevel: boolean,
): ContentScriptDocumentContext {
  const frameId = isTopLevel ? 0 : (nextFrameIds.get(tabId) ?? 1);
  if (isTopLevel) nextFrameIds.set(tabId, 1);
  else nextFrameIds.set(tabId, frameId + 1);

  return { frameId, documentId: generateDocumentId() };
}

function rememberFrameWindow(tabId: number, frameId: number, win: Window): void {
  let frames = frameWindows.get(tabId);
  if (!frames || frameId === 0) {
    frames = new Map();
    frameWindows.set(tabId, frames);
  }
  frames.set(frameId, new WeakRef(win));
}

export function tabFrameWindows(tabId: number): Map<number, Window> {
  const live = new Map<number, Window>();
  for (const [frameId, ref] of frameWindows.get(tabId) ?? []) {
    const win = ref.deref();
    if (win && !win.closed) live.set(frameId, win);
  }
  return live;
}

export async function injectContentScripts(
  win: Window,
  tabId: number,
  url: string,
  isTopLevel: boolean,
  registry: RivetRegistry,
  host: RivetHostBindings,
  nativeDom?: NativeDomOperations,
  scopeBindings: Record<string, unknown> = {},
): Promise<void> {
  if (!url) return;
  const matching = registry.contentScripts.filter(
    (cs) =>
      (isTopLevel || cs.allFrames) &&
      urlMatchesPatterns(url, cs.matches, cs.excludeMatches) &&
      (!cs.includeGlobs?.length ||
        cs.includeGlobs.some((glob) => urlMatchesGlob(url, glob))) &&
      !cs.excludeGlobs?.some((glob) => urlMatchesGlob(url, glob)),
  );
  if (!matching.length) return;

  const { documentId, frameId } = getDocumentContext(tabId, isTopLevel);
  rememberFrameWindow(tabId, frameId, win);

  const scopes = new Map<string, object>();
  const contentScope = (extId: string): object => {
    const existing = scopes.get(extId);
    if (existing) return existing;
    const { chrome, browser } = createChromeApi(win, {
      extId,
      tabId,
      isBackground: false,
      registry,
      host,
      senderUrl: url,
      senderFrameId: frameId,
      senderDocumentId: documentId,
    });
    const scope = createContentScriptScope(win, extId, {
      ...scopeBindings,
      chrome,
      browser,
    });
    scopes.set(extId, scope);
    return scope;
  };

  const byRunAt: Record<
    ContentScriptRegistration["runAt"],
    ContentScriptRegistration[]
  > = {
    document_start: [],
    document_end: [],
    document_idle: [],
  };
  for (const cs of matching) {
    const ext = registry.get(cs.extId);
    if (!ext?.enabled) continue;
    byRunAt[cs.runAt].push(cs);
  }

  const injectGroup = async (group: ContentScriptRegistration[]) => {
    for (const cs of group) {
      const scope = contentScope(cs.extId);
      for (const asset of cs.css) {
        const cached = cachedContentScriptAsset(cs.extId, asset, registry);
        const css =
          cached === undefined
            ? await readContentScriptAsset(cs.extId, asset)
            : cached;
        if (css) injectStyle(win, css, nativeDom);
      }
      for (const asset of cs.js) {
        const cached = cachedContentScriptAsset(cs.extId, asset, registry);
        const code =
          cached === undefined
            ? await readContentScriptAsset(cs.extId, asset)
            : cached;
        if (code) runInContentScope(win, scope, code);
      }
    }
  };

  const injectCachedGroup = (group: ContentScriptRegistration[]): boolean => {
    if (
      group.some((cs) =>
        [...cs.css, ...cs.js].some(
          (asset) =>
            cachedContentScriptAsset(cs.extId, asset, registry) === undefined,
        ),
      )
    ) {
      return false;
    }
    for (const cs of group) {
      const scope = contentScope(cs.extId);
      for (const asset of cs.css) {
        const css = cachedContentScriptAsset(cs.extId, asset, registry);
        if (css) injectStyle(win, css, nativeDom);
      }
      for (const asset of cs.js) {
        const code = cachedContentScriptAsset(cs.extId, asset, registry);
        if (code) runInContentScope(win, scope, code);
      }
    }
    return true;
  };

  if (!injectCachedGroup(byRunAt.document_start)) {
    await injectGroup(byRunAt.document_start);
  }
  if (byRunAt.document_end.length) {
    win.addEventListener(
      "DOMContentLoaded",
      () => void injectGroup(byRunAt.document_end),
      { once: true },
    );
  }
  if (byRunAt.document_idle.length) {
    win.addEventListener(
      "load",
      () => void injectGroup(byRunAt.document_idle),
      { once: true },
    );
  }
}

const globPatterns = new Map<string, RegExp | null>();

function urlMatchesGlob(url: string, glob: string): boolean {
  let pattern = globPatterns.get(glob);
  if (pattern === undefined) {
    try {
      const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      pattern = new RegExp(`^${escaped}$`);
    } catch {
      pattern = null;
    }
    if (globPatterns.size >= 512)
      globPatterns.delete(globPatterns.keys().next().value!);
    globPatterns.set(glob, pattern);
  }
  return pattern?.test(url) ?? false;
}

async function readContentScriptAsset(
  extId: string,
  asset: ContentScriptAsset,
): Promise<string | null> {
  if (typeof asset === "string")
    return readExtFileText(extId, asset.replace(/^\//, ""));
  if (typeof asset.code === "string") return asset.code;
  if (typeof asset.file === "string")
    return readExtFileText(extId, asset.file.replace(/^\//, ""));
  return null;
}
