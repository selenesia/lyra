import { isSensitiveSyncName, isSensitiveSyncText } from "./syncPolicy.ts";

type FolioCookie = {
  name?: unknown;
  value?: unknown;
  httpOnly?: unknown;
  [key: string]: unknown;
};

function parseFolioCookies(value: unknown): Record<string, FolioCookie> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const cookies: Record<string, FolioCookie> = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (
        id.length > 2048 ||
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry)
      ) {
        continue;
      }
      const cookie = entry as FolioCookie;
      if (
        typeof cookie.name !== "string" ||
        cookie.name.length > 256 ||
        typeof cookie.value !== "string" ||
        cookie.value.length > 4096 ||
        Object.keys(cookie).length > 32 ||
        ["domain", "path", "sameSite"].some(
          (field) => field in cookie && typeof cookie[field] !== "string",
        ) ||
        ["hostOnly", "secure", "httpOnly", "partitioned"].some(
          (field) => field in cookie && typeof cookie[field] !== "boolean",
        ) ||
        ["expires", "maxAge"].some(
          (field) => field in cookie && typeof cookie[field] !== "number",
        ) ||
        (typeof cookie.domain === "string" && cookie.domain.length > 253) ||
        (typeof cookie.path === "string" &&
          (!cookie.path.startsWith("/") || cookie.path.length > 1024)) ||
        (typeof cookie.sameSite === "string" && cookie.sameSite.length > 64) ||
        Object.entries(cookie).some(
          ([key, field]) =>
            key.length > 256 ||
            !(
              field === null ||
              ["string", "number", "boolean"].includes(typeof field)
            ),
        )
      ) {
        continue;
      }
      cookies[id] = cookie;
    }
    return cookies;
  } catch {
    return {};
  }
}

function splitFolioCookies(value: unknown): {
  safe: Record<string, FolioCookie>;
  local: Record<string, FolioCookie>;
} {
  const safe: Record<string, FolioCookie> = {};
  const local: Record<string, FolioCookie> = {};
  for (const [id, cookie] of Object.entries(parseFolioCookies(value))) {
    const name = typeof cookie?.name === "string" ? cookie.name : id;
    if (
      cookie?.httpOnly === true ||
      isSensitiveSyncName(name) ||
      (typeof cookie?.value === "string" && isSensitiveSyncText(cookie.value))
    ) {
      local[id] = cookie;
    } else {
      safe[id] = cookie;
    }
  }
  return { safe, local };
}

export function sanitizeFolioCookieState(
  value: unknown,
  includeSensitive: boolean,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const cookies = (value as Record<string, unknown>).cookies;
  return {
    updatedAt: 0,
    cookies: JSON.stringify(
      includeSensitive
        ? parseFolioCookies(cookies)
        : splitFolioCookies(cookies).safe,
    ),
  };
}

export function mergeFolioCookieState(
  remote: unknown,
  local: unknown,
  includeSensitive: boolean,
): unknown {
  const remoteCookies =
    typeof remote === "object" && remote !== null
      ? (remote as Record<string, unknown>).cookies
      : undefined;
  const localCookies =
    typeof local === "object" && local !== null
      ? (local as Record<string, unknown>).cookies
      : undefined;
  const merged = includeSensitive
    ? parseFolioCookies(remoteCookies)
    : {
        ...splitFolioCookies(remoteCookies).safe,
        ...splitFolioCookies(localCookies).local,
      };
  const localUpdatedAt =
    typeof local === "object" &&
    local !== null &&
    typeof (local as Record<string, unknown>).updatedAt === "number"
      ? ((local as Record<string, number>).updatedAt ?? 0)
      : 0;
  return {
    updatedAt: Math.max(Date.now(), localUpdatedAt + 1),
    cookies: JSON.stringify(merged),
  };
}
