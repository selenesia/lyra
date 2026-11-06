import { negativeMessage } from "../runtime/messages.ts";

declare const __LYRA_UBLOCK_VERSION__: string;

const UBLOCK_ORIGIN_EXTENSION_URL = "/b/rivet/ublock.crx";
const BUNDLED_UBLOCK_VERSION =
  typeof __LYRA_UBLOCK_VERSION__ === "string" ? __LYRA_UBLOCK_VERSION__ : "";

interface InstalledExtension {
  id: string;
  name: string;
  version: string | undefined;
  enabled: boolean;
}

export interface RivetExtensionInstaller {
  getInstalledExtensions(): readonly InstalledExtension[];
  installExtension(
    buffer: ArrayBuffer,
    filename: string,
    replacesId?: string,
  ): Promise<string>;
  setExtensionEnabled(extId: string, enabled: boolean): Promise<void>;
}

export function compareExtensionVersions(
  left: string | undefined,
  right: string | undefined,
): number {
  const leftParts = (left ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = (right ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function newestInstalledUblock(
  rivet: Pick<RivetExtensionInstaller, "getInstalledExtensions">,
): InstalledExtension | undefined {
  return rivet
    .getInstalledExtensions()
    .filter(
      (extension) => extension.name.trim().toLowerCase() === "ublock origin",
    )
    .reduce<InstalledExtension | undefined>(
      (newest, extension) =>
        !newest || compareExtensionVersions(extension.version, newest.version) > 0
          ? extension
          : newest,
      undefined,
    );
}

function isCurrentUblock(
  extension: InstalledExtension,
  bundledVersion: string,
): boolean {
  return (
    !bundledVersion ||
    compareExtensionVersions(extension.version, bundledVersion) >= 0
  );
}

export function hasCurrentUblock(
  rivet: Pick<RivetExtensionInstaller, "getInstalledExtensions">,
  bundledVersion = BUNDLED_UBLOCK_VERSION,
): boolean {
  const existing = newestInstalledUblock(rivet);
  return Boolean(existing && isCurrentUblock(existing, bundledVersion));
}

export async function ensureUblockOrigin(
  rivet: RivetExtensionInstaller,
  fetchImpl: typeof fetch = globalThis.fetch,
  bundledVersion = BUNDLED_UBLOCK_VERSION,
): Promise<string> {
  const existing = newestInstalledUblock(rivet);
  if (existing && isCurrentUblock(existing, bundledVersion)) {
    if (!existing.enabled) await rivet.setExtensionEnabled(existing.id, true);
    return existing.id;
  }

  const response = await fetchImpl(UBLOCK_ORIGIN_EXTENSION_URL);
  if (!response.ok) {
    throw new Error(
      negativeMessage(
        `ublock origin asset is unavailable (${response.status})`,
      ),
    );
  }
  return rivet.installExtension(
    await response.arrayBuffer(),
    "ublock.crx",
    existing?.id,
  );
}
