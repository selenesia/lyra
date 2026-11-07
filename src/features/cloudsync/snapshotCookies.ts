import { isSensitiveSyncName, isSensitiveSyncText } from "./syncPolicy.ts";
import type { SyncCookie, SyncSameSite } from "./snapshotSchema.ts";

interface CookieStoreEntry {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  sameSite?: unknown;
  secure?: unknown;
  partitioned?: unknown;
}

interface CookieStoreLike {
  getAll(): Promise<CookieStoreEntry[]>;
  delete(options: {
    name: string;
    domain?: string;
    path?: string;
    partitioned?: boolean;
  }): Promise<void>;
}

function exportCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name || isSensitiveSyncName(name)) continue;
    const value = part.slice(separator + 1).trim();
    if (!isSensitiveSyncText(value)) cookies[name] = value;
  }
  return Object.fromEntries(
    Object.entries(cookies).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;
const COOKIE_VALUE_PATTERN = /^[\x21-\x7e]*$/;
const COOKIE_DOMAIN_PATTERN = /^\.?[a-zA-Z0-9.-]+$/;

function cookieStore(): CookieStoreLike | null {
  const store = (globalThis as unknown as { cookieStore?: unknown })
    .cookieStore;
  if (
    typeof store !== "object" ||
    store === null ||
    typeof (store as CookieStoreLike).getAll !== "function" ||
    typeof (store as CookieStoreLike).delete !== "function"
  ) {
    return null;
  }
  return store as CookieStoreLike;
}

export function credentialCookieName(name: string): boolean {
  return (
    isSensitiveSyncName(name) ||
    name.startsWith("__Http-") ||
    name.startsWith("__Host-Http-")
  );
}

export function validCookie(cookie: SyncCookie): boolean {
  if (
    cookie.name.length > 256 ||
    !COOKIE_NAME_PATTERN.test(cookie.name) ||
    credentialCookieName(cookie.name) ||
    !COOKIE_VALUE_PATTERN.test(cookie.value) ||
    cookie.value.length > 4096 ||
    /[";,\\]/.test(cookie.value) ||
    isSensitiveSyncText(cookie.value) ||
    (cookie.domain !== null &&
      (cookie.domain.length > 253 ||
        !COOKIE_DOMAIN_PATTERN.test(cookie.domain) ||
        cookie.domain.includes(".."))) ||
    !cookie.path.startsWith("/") ||
    cookie.path.length > 1024 ||
    /[;\x00-\x1f\x7f]/.test(cookie.path) ||
    (cookie.expires !== null &&
      (!Number.isFinite(cookie.expires) ||
        cookie.expires < 0 ||
        cookie.expires > 8.64e15)) ||
    !["strict", "lax", "none"].includes(cookie.sameSite) ||
    (cookie.sameSite === "none" && !cookie.secure) ||
    (cookie.partitioned && !cookie.secure)
  ) {
    return false;
  }
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return false;
  if (
    cookie.name.startsWith("__Host-") &&
    (!cookie.secure || cookie.domain !== null || cookie.path !== "/")
  ) {
    return false;
  }
  return true;
}

export function cookieIdentity(cookie: SyncCookie): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain?.toLowerCase() ?? null,
    cookie.path,
    cookie.partitioned,
  ]);
}

function sortCookies(cookies: SyncCookie[]): SyncCookie[] {
  return cookies.sort((left, right) =>
    cookieIdentity(left).localeCompare(cookieIdentity(right)),
  );
}

export function legacyCookies(cookieHeader: string): SyncCookie[] {
  const secure =
    (globalThis as unknown as { location?: { protocol?: string } }).location
      ?.protocol === "https:";
  return sortCookies(
    Object.entries(exportCookies(cookieHeader)).map(([name, value]) => ({
      name,
      value,
      domain: null,
      path: "/",
      expires: null,
      sameSite: "lax" as const,
      secure,
      partitioned: false,
    })),
  );
}

export async function exportBrowserCookies(): Promise<SyncCookie[]> {
  const store = cookieStore();
  if (!store) return legacyCookies(globalThis.document.cookie);
  try {
    const secureContext =
      (globalThis as unknown as { location?: { protocol?: string } }).location
        ?.protocol === "https:";
    const cookies: SyncCookie[] = [];
    for (const entry of await store.getAll()) {
      if (typeof entry.name !== "string" || typeof entry.value !== "string")
        continue;
      const sameSite = ["strict", "lax", "none"].includes(
        String(entry.sameSite),
      )
        ? (entry.sameSite as SyncSameSite)
        : "lax";
      const cookie: SyncCookie = {
        name: entry.name,
        value: entry.value,
        domain:
          typeof entry.domain === "string" && entry.domain
            ? entry.domain
            : null,
        path: typeof entry.path === "string" && entry.path ? entry.path : "/",
        expires:
          typeof entry.expires === "number" && Number.isFinite(entry.expires)
            ? entry.expires
            : null,
        sameSite,
        secure:
          typeof entry.secure === "boolean" ? entry.secure : secureContext,
        partitioned: entry.partitioned === true,
      };
      if (validCookie(cookie)) cookies.push(cookie);
    }
    return sortCookies(cookies);
  } catch {
    return legacyCookies(globalThis.document.cookie);
  }
}

function expireCookie(name: string): void {
  const expires = "thu, 01 jan 1970 00:00:00 gmt";
  globalThis.document.cookie = `${name}=; expires=${expires}; max-age=0; path=/; samesite=lax`;
}

function domainMatchesCurrentHost(domain: string | null): boolean {
  if (domain === null) return true;
  const hostname = (
    globalThis as unknown as { location?: { hostname?: string } }
  ).location?.hostname?.toLowerCase();
  if (!hostname) return false;
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function writeCookie(cookie: SyncCookie): void {
  const attributes = [
    `${cookie.name}=${cookie.value}`,
    `path=${cookie.path}`,
    `samesite=${cookie.sameSite}`,
  ];
  if (cookie.domain !== null) attributes.push(`domain=${cookie.domain}`);
  if (cookie.expires !== null) {
    attributes.push(`expires=${new Date(cookie.expires).toUTCString()}`);
  }
  if (cookie.secure) attributes.push("secure");
  if (cookie.partitioned) attributes.push("partitioned");
  globalThis.document.cookie = attributes.join("; ");
}

async function deleteCookie(
  store: CookieStoreLike | null,
  cookie: SyncCookie,
): Promise<void> {
  if (!store) {
    expireCookie(cookie.name);
    return;
  }
  const options: {
    name: string;
    domain?: string;
    path?: string;
    partitioned?: boolean;
  } = {
    name: cookie.name,
    path: cookie.path,
    partitioned: cookie.partitioned,
  };
  if (cookie.domain !== null) options.domain = cookie.domain;
  await store.delete(options);
}

export async function replaceCookies(remote: SyncCookie[]): Promise<number> {
  const current = await exportBrowserCookies();
  const remoteIds = new Set(remote.map(cookieIdentity));
  const currentCookies = new Map(
    current.map((cookie) => [cookieIdentity(cookie), JSON.stringify(cookie)]),
  );
  const store = cookieStore();
  let changes = 0;
  for (const cookie of current) {
    if (remoteIds.has(cookieIdentity(cookie))) continue;
    changes++;
    await deleteCookie(store, cookie);
  }
  for (const cookie of remote) {
    if (
      !domainMatchesCurrentHost(cookie.domain) ||
      currentCookies.get(cookieIdentity(cookie)) === JSON.stringify(cookie)
    ) {
      continue;
    }
    writeCookie(cookie);
    changes++;
  }
  return changes;
}

export async function applyCookieDelta(
  previous: SyncCookie[],
  target: SyncCookie[],
): Promise<number> {
  const store = cookieStore();
  const before = new Map(
    previous.map((cookie) => [cookieIdentity(cookie), JSON.stringify(cookie)]),
  );
  const after = new Set(target.map(cookieIdentity));
  let changes = 0;
  for (const cookie of previous) {
    if (after.has(cookieIdentity(cookie))) continue;
    await deleteCookie(store, cookie);
    changes++;
  }
  for (const cookie of target) {
    if (
      before.get(cookieIdentity(cookie)) === JSON.stringify(cookie) ||
      !domainMatchesCurrentHost(cookie.domain)
    ) {
      continue;
    }
    writeCookie(cookie);
    changes++;
  }
  return changes;
}
