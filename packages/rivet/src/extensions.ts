import { ExtensionArchive } from "./archive";
import { generateExtensionId } from "./crx";
import {
  dbDelete,
  dbDeleteEntries,
  dbGet,
  dbGetAll,
  dbGetEntries,
  dbPut,
  dbPutEntries,
  EXT_FILES_STORE,
  EXT_STORAGE_STORE,
  EXT_STORE,
} from "./db";
import { readExtFileText, readExtFileURL } from "./fileStore";
import {
  startBackground,
  stopBackground,
  type BackgroundLifecycle,
} from "./background";
import {
  preloadContentScriptAssets,
  registerContentScripts,
  unregisterContentScripts,
} from "./contentScripts";
import { getDefaultIcon, resolveManifestI18n } from "./manifest";
import { recomputeStaticRules } from "./dnr";
import { NEGATIVE } from "./messages";
import { setExtensionIcon, type RivetRegistry } from "./registry";
import type { ChromeManifest, ExtensionMeta, RivetHostBindings } from "./types";

export interface InstalledExtensionSummary {
  id: string;
  name: string;
  version: string | undefined;
  enabled: boolean;
  manifest: ChromeManifest;
  iconUrl: string | null;
  title: string | null;
  badgeText: string;
  badgeColor: string | null;
  hasPopup: boolean;
}

function keysWithPrefix(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix.slice(0, -1)}0`, false, true);
}

async function loadMessages(
  extId: string,
  manifest: ChromeManifest,
): Promise<Record<string, { message: string }>> {
  const defaultLocale = manifest.default_locale ?? "en";
  const primary = await readExtFileText(
    extId,
    `_locales/${defaultLocale}/messages.json`,
  );
  if (primary) {
    try {
      return JSON.parse(primary);
    } catch {}
  }
  if (defaultLocale !== "en") {
    const en = await readExtFileText(extId, "_locales/en/messages.json");
    if (en) {
      try {
        return JSON.parse(en);
      } catch {}
    }
  }
  return {};
}

async function loadExtension(
  meta: ExtensionMeta,
  registry: RivetRegistry,
  host: RivetHostBindings,
  backgroundRoot: HTMLElement,
  lifecycle: BackgroundLifecycle = {},
): Promise<void> {
  const ext = registry.createExtensionState(
    meta.id,
    meta.manifest,
    meta.enabled !== false,
    meta.installedAt,
    meta.filename,
  );
  let reloadPending = false;
  ext.reloadBackground = () => {
    if (reloadPending || !ext.enabled || registry.get(ext.id) !== ext) return;
    reloadPending = true;
    queueMicrotask(() => {
      reloadPending = false;
      if (!ext.enabled || registry.get(ext.id) !== ext) return;
      void startBackground(ext, registry, host, backgroundRoot).catch((e) => {
        console.error(
          "[rivet] background reload failed for extension",
          ext.manifest.name,
          e,
          NEGATIVE,
        );
      });
    });
  };

  registerContentScripts(ext, registry);
  const defaultIconPath = getDefaultIcon(ext.manifest);
  const prepared = await Promise.allSettled([
    loadMessages(ext.id, ext.manifest).then((messages) => {
      ext.messages = messages;
      resolveManifestI18n(ext.manifest, messages);
    }),
    preloadContentScriptAssets(ext, registry),
    defaultIconPath
      ? readExtFileURL(ext.id, defaultIconPath)
          .then((url) => {
            if (registry.get(ext.id) === ext) setExtensionIcon(ext, url);
            else if (url) URL.revokeObjectURL(url);
          })
          .catch((e) => {
            console.warn(
              "[rivet] default icon resolution failed for extension",
              ext.manifest.name,
              e,
              NEGATIVE,
            );
          })
      : undefined,
  ]);
  for (const result of prepared)
    if (result.status === "rejected") throw result.reason;

  const ruleResources =
    ext.manifest.declarative_net_request?.rule_resources ?? [];
  for (let offset = 0; offset < ruleResources.length; offset += 8) {
    const batch = ruleResources.slice(offset, offset + 8);
    const texts = await Promise.all(
      batch.map((ruleSet) =>
        ruleSet.path && ruleSet.id
          ? readExtFileText(ext.id, ruleSet.path)
          : null,
      ),
    );
    for (const [index, ruleSet] of batch.entries()) {
      const rulesText = texts[index];
      if (!rulesText || !ruleSet.id) continue;
      try {
        ext.rulesetRules.set(ruleSet.id, JSON.parse(rulesText));
        if (ruleSet.enabled !== false) ext.enabledRulesetIds.add(ruleSet.id);
      } catch (e) {
        console.warn(
          "[rivet] rule set parsing failed",
          ruleSet.path,
          e,
          NEGATIVE,
        );
      }
    }
  }
  recomputeStaticRules(ext);

  if (ext.enabled) {
    try {
      await startBackground(ext, registry, host, backgroundRoot, lifecycle);
    } catch (e) {
      console.error(
        "[rivet] background startup failed for extension",
        ext.manifest.name,
        e,
        NEGATIVE,
      );
    }
  }

  registry.notifyChange();
}

export async function loadStoredExtensions(
  registry: RivetRegistry,
  host: RivetHostBindings,
  backgroundRoot: HTMLElement,
): Promise<number> {
  const stored = await dbGetAll<ExtensionMeta>(EXT_STORE);
  const cleared = await Promise.allSettled(
    stored.map((meta) =>
      dbDeleteEntries(EXT_STORAGE_STORE, keysWithPrefix(`${meta.id}/session/`)),
    ),
  );
  if (cleared.some((result) => result.status === "rejected"))
    console.warn("[rivet] session storage reset failed", NEGATIVE);
  for (let offset = 0; offset < stored.length; offset += 2) {
    await Promise.all(
      stored.slice(offset, offset + 2).map(async (meta) => {
        try {
          await loadExtension(meta, registry, host, backgroundRoot, {
            startup: true,
          });
        } catch (e) {
          unregisterContentScripts(meta.id, registry);
          registry.remove(meta.id);
          console.error(
            "[rivet] stored extension loading failed",
            meta.id,
            e,
            NEGATIVE,
          );
        }
      }),
    );
  }
  return stored.length;
}

export async function installExtension(
  buffer: ArrayBuffer,
  filename: string,
  registry: RivetRegistry,
  host: RivetHostBindings,
  backgroundRoot: HTMLElement,
  replacesId?: string,
): Promise<string> {
  const archive = new ExtensionArchive();
  let meta: ExtensionMeta;
  let previousId: string | undefined;
  try {
    const { manifest, fileList } = await archive.open(buffer);
    const extId = generateExtensionId(manifest.name + (manifest.version ?? ""));
    if (registry.get(extId)) await uninstallExtension(extId, registry);
    previousId = replacesId === extId ? undefined : replacesId;
    meta = {
      id: extId,
      manifest,
      enabled: true,
      installedAt: Date.now(),
      filename,
      fileList,
    };
    try {
      for (let offset = 0; offset < fileList.length; offset += 16) {
        const paths = fileList.slice(offset, offset + 16);
        const files = await archive.readFiles(paths);
        await dbPutEntries(
          EXT_FILES_STORE,
          paths.map((path, index) => [`${extId}/${path}`, files[index]] as const),
        );
      }
      if (previousId) {
        const previousPrefix = `${previousId}/`;
        const storage = await dbGetEntries(
          EXT_STORAGE_STORE,
          keysWithPrefix(previousPrefix),
        );
        await dbPutEntries(
          EXT_STORAGE_STORE,
          storage
            .filter(([key]) => !key.startsWith(`${previousPrefix}session/`))
            .map(([key, value]) => [
              `${extId}/${key.slice(previousPrefix.length)}`,
              value,
            ] as const),
        );
      }
      await dbPut(EXT_STORE, null, meta);
    } catch (error) {
      await Promise.all([
        dbDeleteEntries(EXT_FILES_STORE, keysWithPrefix(`${extId}/`)),
        dbDeleteEntries(EXT_STORAGE_STORE, keysWithPrefix(`${extId}/`)),
      ]);
      throw error;
    }
  } finally {
    archive.close();
  }
  if (previousId) await uninstallExtension(previousId, registry);
  await loadExtension(meta, registry, host, backgroundRoot, {
    installedReason: previousId ? "update" : "install",
  });
  return meta.id;
}

export async function uninstallExtension(
  extId: string,
  registry: RivetRegistry,
): Promise<void> {
  const ext = registry.get(extId);
  if (!ext) return;

  stopBackground(ext);
  unregisterContentScripts(extId, registry);
  registry.remove(extId);

  await dbDelete(EXT_STORE, extId);
  await Promise.all([
    dbDeleteEntries(EXT_FILES_STORE, keysWithPrefix(`${extId}/`)),
    dbDeleteEntries(EXT_STORAGE_STORE, keysWithPrefix(`${extId}/`)),
  ]);
  registry.notifyChange();
}

export async function setExtensionEnabled(
  extId: string,
  enabled: boolean,
  registry: RivetRegistry,
  host: RivetHostBindings,
  backgroundRoot: HTMLElement,
): Promise<void> {
  const ext = registry.get(extId);
  if (!ext) return;
  ext.enabled = enabled;
  const stored = await dbGet<ExtensionMeta>(EXT_STORE, extId);
  if (stored) {
    stored.enabled = enabled;
    await dbPut(EXT_STORE, null, stored);
  }
  if (enabled) {
    await startBackground(ext, registry, host, backgroundRoot);
  } else {
    stopBackground(ext);
  }
  registry.notifyChange();
}

export function getInstalledExtensions(
  registry: RivetRegistry,
): InstalledExtensionSummary[] {
  return registry.list().map((ext) => ({
    id: ext.id,
    name: ext.manifest.name,
    version: ext.manifest.version,
    enabled: ext.enabled,
    manifest: ext.manifest,
    iconUrl: ext.iconUrl,
    title: ext.title,
    badgeText: ext.badgeText,
    badgeColor: ext.badgeColor,
    hasPopup: Boolean(
      ext.popupPage ??
      ext.manifest.action?.default_popup ??
      ext.manifest.browser_action?.default_popup ??
      ext.manifest.page_action?.default_popup,
    ),
  }));
}
