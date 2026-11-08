import { backgroundTask } from "../runtime/backgroundTask.ts";
import { NEGATIVE, negativeMessage } from "../runtime/messages.ts";
import { readUblockState } from "./ublockState.ts";

declare const __LYRA_UBLOCK_VERSION__: string;

const UBLOCK_ORIGIN_EXTENSION_URL = "/b/rivet/ublock.crx";
const UBLOCK_ORIGIN_STATE_URL = "/b/rivet/ublock.state.gz";
export const UBLOCK_FILTERING_READY_EVENT = "onSendHeaders";
const BUNDLED_UBLOCK_VERSION =
  typeof __LYRA_UBLOCK_VERSION__ === "string" ? __LYRA_UBLOCK_VERSION__ : "";
const UBLOCK_FLAVOR_TOKENS = ["chromium", "mobile", "native_css_has", "brave"];
const readUblockStateInBackground = backgroundTask(
  () =>
    new Worker(new URL("./ublockState.worker.ts", import.meta.url), {
      type: "module",
    }),
  readUblockState,
);

export interface UblockInstallOptions {
  fetchImpl?: typeof fetch;
  bundledVersion?: string;
  beforeInstall?: (prebuilt: boolean) => Promise<void>;
  environment?: () => UblockEnvironment;
  readState?: () => Promise<unknown>;
}

export interface UblockEnvironment {
  flavor: string[];
  language: string;
  userAgent: string;
  now: number;
}

interface PrebuiltUblockState {
  version: string;
  createdAt: number;
  flavor: string[];
  language: string;
  regionalLanguages: string[];
  regionalAgents: string[];
  storage: Record<string, unknown>;
}

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
    initialLocalStorage?: Record<string, unknown>,
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

function isUblock(extension: InstalledExtension): boolean {
  return extension.name.trim().toLowerCase() === "ublock origin";
}

export function isStartingUblock(
  rivet: Pick<RivetExtensionInstaller, "getInstalledExtensions"> & {
    registry: {
      hasWebRequestListener(
        extId: string,
        event: typeof UBLOCK_FILTERING_READY_EVENT,
      ): boolean;
    };
  },
  extId: string,
): boolean {
  return (
    rivet
      .getInstalledExtensions()
      .some((extension) => extension.id === extId && isUblock(extension)) &&
    !rivet.registry.hasWebRequestListener(extId, UBLOCK_FILTERING_READY_EVENT)
  );
}

function newestInstalledUblock(
  rivet: Pick<RivetExtensionInstaller, "getInstalledExtensions">,
): InstalledExtension | undefined {
  return rivet
    .getInstalledExtensions()
    .filter(isUblock)
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

export function currentUblockEnvironment(): UblockEnvironment {
  const userAgent = navigator.userAgent;
  const browser = navigator as Navigator & {
    brave?: unknown;
    userAgentData?: { brands?: { brand: string }[] };
  };
  const detected: Record<string, boolean> = {
    chromium: /\bChrom(?:e|ium)\/\d+/.test(userAgent),
    mobile: /\bMobile\b/.test(userAgent),
    native_css_has: Boolean(globalThis.CSS?.supports?.("selector(a:has(b))")),
    brave:
      browser.brave instanceof Object ||
      Boolean(browser.userAgentData?.brands?.some(({ brand }) => brand === "Brave")),
  };
  return {
    flavor: UBLOCK_FLAVOR_TOKENS.filter((token) => detected[token]),
    language: /^[a-z]+/.exec(navigator.language || "en")?.[0] ?? "",
    userAgent,
    now: Date.now(),
  };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPrebuiltUblockState(value: unknown): value is PrebuiltUblockState {
  const state = value as Partial<PrebuiltUblockState> | null;
  return (
    typeof state === "object" &&
    state !== null &&
    typeof state.version === "string" &&
    typeof state.createdAt === "number" &&
    typeof state.language === "string" &&
    isStringList(state.flavor) &&
    isStringList(state.regionalLanguages) &&
    isStringList(state.regionalAgents) &&
    typeof state.storage === "object" &&
    state.storage !== null
  );
}

function prebuiltStateFits(
  state: PrebuiltUblockState,
  bundledVersion: string,
  environment: UblockEnvironment,
): boolean {
  if (!bundledVersion || state.version !== bundledVersion) return false;
  const builtFor = UBLOCK_FLAVOR_TOKENS.filter((token) => state.flavor.includes(token));
  if (builtFor.join() !== environment.flavor.join()) return false;
  if (
    environment.language !== state.language &&
    (state.regionalLanguages.includes(environment.language) ||
      state.regionalLanguages.includes(state.language))
  )
    return false;
  return !state.regionalAgents.some((agent) =>
    new RegExp(`\\b${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
      environment.userAgent,
    ),
  );
}

function rebasedStorage(
  state: PrebuiltUblockState,
  now: number,
): Record<string, unknown> {
  const registry = state.storage.assetCacheRegistry;
  if (!registry || typeof registry !== "object") return state.storage;
  const shift = now - state.createdAt;
  return {
    ...state.storage,
    assetCacheRegistry: Object.fromEntries(
      Object.entries(registry as Record<string, unknown>).map(([key, entry]) => {
        if (!entry || typeof entry !== "object") return [key, entry];
        const rebased: Record<string, unknown> = { ...entry };
        for (const field of ["writeTime", "readTime"]) {
          const time = rebased[field];
          if (typeof time === "number" && time > 0) rebased[field] = time + shift;
        }
        return [key, rebased];
      }),
    ),
  };
}

function readBundledUblockState(): Promise<unknown> {
  return readUblockStateInBackground(
    new URL(UBLOCK_ORIGIN_STATE_URL, document.baseURI).href,
  );
}

async function prebuiltUblockStorage(
  bundledVersion: string,
  environment: () => UblockEnvironment,
  readState: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  if (!environment().flavor.includes("chromium")) return null;
  try {
    const state = await readState();
    if (!isPrebuiltUblockState(state)) return null;
    const current = environment();
    return prebuiltStateFits(state, bundledVersion, current)
      ? rebasedStorage(state, current.now)
      : null;
  } catch (error) {
    console.warn(
      "[rivet] prebuilt ublock origin state is unavailable:",
      error,
      NEGATIVE,
    );
    return null;
  }
}

async function fetchUblockCrx(fetchImpl: typeof fetch): Promise<ArrayBuffer> {
  const response = await fetchImpl(UBLOCK_ORIGIN_EXTENSION_URL);
  if (!response.ok) {
    throw new Error(
      negativeMessage(
        `ublock origin asset is unavailable (${response.status})`,
      ),
    );
  }
  return response.arrayBuffer();
}

export async function ensureUblockOrigin(
  rivet: RivetExtensionInstaller,
  {
    fetchImpl = globalThis.fetch,
    bundledVersion = BUNDLED_UBLOCK_VERSION,
    beforeInstall,
    environment = currentUblockEnvironment,
    readState = readBundledUblockState,
  }: UblockInstallOptions = {},
): Promise<string> {
  const existing = newestInstalledUblock(rivet);
  if (existing && isCurrentUblock(existing, bundledVersion)) {
    if (!existing.enabled) await rivet.setExtensionEnabled(existing.id, true);
    return existing.id;
  }

  const [crx, storage] = await Promise.all([
    fetchUblockCrx(fetchImpl),
    existing
      ? null
      : prebuiltUblockStorage(bundledVersion, environment, readState),
  ]);
  await beforeInstall?.(storage !== null);
  return rivet.installExtension(
    crx,
    "ublock.crx",
    existing?.id,
    storage ?? undefined,
  );
}
