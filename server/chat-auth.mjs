import { createHash } from "crypto";
import { NEGATIVE } from "../src/core/runtime/messages.ts";

const SESSION_COOKIE = "token";
const CACHE_LIMIT = 5_000;

function cloudsyncOrigin() {
  return process.env.CLOUDSYNC_ORIGIN || `http://127.0.0.1:${process.env.CLOUDSYNC_PORT || "4005"}`;
}

function sessionToken(cookieHeader) {
  for (const part of (cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export class ChatAuthUnavailable extends Error {}

export function createCloudsyncIdentity({
  origin = cloudsyncOrigin(),
  ttlMs = 60_000,
  missTtlMs = 5_000,
  timeoutMs = 3_000,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();

  return async function identify(request, ip) {
    const token = sessionToken(request.headers.get("cookie"));
    if (!token) return null;
    const key = createHash("sha256").update(token).digest("base64url");
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.user;

    let response;
    try {
      response = await fetchImpl(`${origin}/api/auth/me`, {
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          ...(ip && { "x-forwarded-for": ip }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.warn("chat could not reach cloudsync:", error?.name, NEGATIVE);
      throw new ChatAuthUnavailable();
    }
    let user = null;
    if (response.ok) {
      const body = await response.json().catch(() => null);
      const id = Number(body?.user?.id);
      const username = body?.user?.username;
      const createdAt = Number(body?.user?.created_at);
      if (Number.isSafeInteger(id) && id > 0 && typeof username === "string" && username) {
        user = { id, username, ...(Number.isSafeInteger(createdAt) && createdAt > 0 && { createdAt }) };
      }
    } else if (response.status !== 401 && response.status !== 403) {
      console.warn("chat session check failed with status", response.status, NEGATIVE);
      throw new ChatAuthUnavailable();
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, { user, expires: now() + (user ? ttlMs : missTtlMs) });
    return user;
  };
}
