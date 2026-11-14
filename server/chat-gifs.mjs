import { httpError } from "./errors.mjs";
import { chatImageType, readChatImage } from "./chat-media.mjs";
import { NEGATIVE } from "../src/core/runtime/messages.ts";
import { CHAT_ATTACHMENT, CHAT_GIFS } from "../src/features/chat/chatProtocol.ts";

const API_ORIGIN = "https://gifsnap.com/api/v1";
const MEDIA_HOSTS = new Set(["media.gifsnap.com"]);
const GIF_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIEW_TYPES = new Set(["image/webp", "image/jpeg", "image/gif"]);
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_CACHE_BYTES = 24 * 1024 * 1024;
const PAGE_TTL_MS = 10 * 60_000;
const PAGE_CACHE_LIMIT = 200;
const ITEM_TTL_MS = 60 * 60_000;
const ITEM_CACHE_LIMIT = 10_000;
const SEARCH_TIMEOUT_MS = 6_000;
const MEDIA_TIMEOUT_MS = 15_000;
const MEDIA_CACHE = "private, max-age=86400, immutable";

const unavailable = () => httpError(503, "CHAT_GIFS_UNAVAILABLE", "gif search is unavailable right now");
const missing = () => httpError(404, "CHAT_GIF_NOT_FOUND", "that gif is gone");
const tooLarge = () => httpError(413, "CHAT_GIF_TOO_LARGE", "that gif is too large to send");
const unusable = () => httpError(422, "CHAT_GIF_INVALID", "that gif could not be used");
const rateLimited = () => httpError(429, "CHAT_RATE_LIMITED", "slow down a little");

function mediaUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && MEDIA_HOSTS.has(url.hostname) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function readGif(raw, needsPreview = false) {
  if (!raw || typeof raw !== "object" || raw.type !== "gif" || typeof raw.id !== "string" || !GIF_ID.test(raw.id)) return null;
  const full = mediaUrl(raw.url);
  const preview = mediaUrl(raw.preview_url);
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  if (!full || (needsPreview && !preview) || !full.pathname.toLowerCase().endsWith(".gif")) return null;
  if (!(width >= 1 && height >= 1 && width <= CHAT_ATTACHMENT.gif.width && height <= CHAT_ATTACHMENT.gif.height)) return null;
  return {
    id: raw.id,
    group: typeof raw.content_id === "string" && raw.content_id ? raw.content_id : raw.id,
    title: typeof raw.title === "string" ? raw.title.trim().slice(0, CHAT_GIFS.title) : "",
    width,
    height,
    full: full.href,
    preview: (preview ?? full).href,
  };
}

async function readCapped(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function remember(map, key, value, limit) {
  map.delete(key);
  if (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value);
}

export function createChatGifs({
  fetchImpl = fetch,
  now = Date.now,
  searchLimit = 10,
  searchWindowMs = 8_000,
  mediaLimit = 240,
  mediaWindowMs = 60_000,
} = {}) {
  const pages = new Map();
  const pending = new Map();
  const items = new Map();
  const previews = new Map();
  const windows = new Map();
  let previewBytes = 0;

  function allow(userId, kind, limit, windowMs) {
    const key = `${kind}:${userId}`;
    const time = now();
    const recent = (windows.get(key) ?? []).filter((at) => time - at < windowMs);
    if (recent.length >= limit) {
      windows.set(key, recent);
      return false;
    }
    recent.push(time);
    if (windows.size >= ITEM_CACHE_LIMIT) windows.clear();
    windows.set(key, recent);
    return true;
  }

  async function upstream(path) {
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.warn("chat gif search could not reach gifsnap:", error?.name, NEGATIVE);
      return { failure: unavailable() };
    }
    if (response.status === 404) return { missing: true };
    if (!response.ok) {
      console.warn("chat gif search failed with status", response.status, NEGATIVE);
      return { failure: unavailable() };
    }
    const body = await response.json().catch(() => null);
    return body && typeof body === "object" ? { body } : { failure: unavailable() };
  }

  function keep(gif) {
    remember(items, gif.id, { ...gif, expires: now() + ITEM_TTL_MS }, ITEM_CACHE_LIMIT);
  }

  async function fetchPage(query, page) {
    const params = new URLSearchParams({ page: String(page), limit: String(CHAT_GIFS.page) });
    if (query) params.set("q", query);
    const { body, failure } = await upstream(`/gifs/${query ? "search" : "trending"}?${params}`);
    if (failure) return failure;
    const seen = new Set();
    const gifs = [];
    for (const raw of Array.isArray(body?.data) ? body.data : []) {
      const gif = readGif(raw, true);
      if (!gif || seen.has(gif.group)) continue;
      seen.add(gif.group);
      keep(gif);
      gifs.push({ id: gif.id, title: gif.title, width: gif.width, height: gif.height });
    }
    const next = Number(body?.pagination?.next_page);
    const more = body?.pagination?.has_next === true && Number.isSafeInteger(next) && next > page && next <= CHAT_GIFS.pages;
    return { status: 200, body: { gifs, next: more ? next : null } };
  }

  async function search(url, userId) {
    const query = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ");
    const rawPage = url.searchParams.get("page");
    const page = rawPage === null ? 1 : Number(rawPage);
    if ([...query].length > CHAT_GIFS.query || !Number.isSafeInteger(page) || page < 1 || page > CHAT_GIFS.pages) {
      return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    }
    const key = `${query.toLowerCase()}\n${page}`;
    const cached = pages.get(key);
    if (cached && cached.expires > now()) return cached.result;
    if (!allow(userId, "search", searchLimit, searchWindowMs)) return rateLimited();
    let lookup = pending.get(key);
    if (!lookup) {
      lookup = fetchPage(query, page).finally(() => pending.delete(key));
      pending.set(key, lookup);
    }
    const result = await lookup;
    if (result.status === 200) remember(pages, key, { result, expires: now() + PAGE_TTL_MS }, PAGE_CACHE_LIMIT);
    return result;
  }

  async function find(id) {
    const known = items.get(id);
    if (known && known.expires > now()) return known;
    const { body, missing: gone, failure } = await upstream(`/gifs/${encodeURIComponent(id)}`);
    if (gone) return null;
    if (failure) return { failure };
    const gif = readGif(body?.data ?? body);
    if (!gif || gif.id !== id) return null;
    keep(gif);
    return gif;
  }

  function image(bytes, type, cache = MEDIA_CACHE) {
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": cache,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  async function download(href, limit) {
    let response;
    try {
      response = await fetchImpl(href, { redirect: "error", signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    } catch (error) {
      console.warn("chat gif media could not be fetched:", error?.name, NEGATIVE);
      return { failure: unavailable() };
    }
    if (response.status === 404 || response.status === 410) return { failure: missing() };
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      console.warn("chat gif media failed with status", response.status, NEGATIVE);
      return { failure: unavailable() };
    }
    try {
      const bytes = await readCapped(response, limit);
      return bytes ? { bytes } : { failure: tooLarge() };
    } catch (error) {
      console.warn("chat gif media download failed:", error?.name, NEGATIVE);
      return { failure: unavailable() };
    }
  }

  async function media(id, size, userId) {
    if (!GIF_ID.test(id) || (size !== "preview" && size !== "full")) return { failure: missing() };
    if (size === "preview") {
      const cached = previews.get(id);
      if (cached) {
        remember(previews, id, cached, Infinity);
        return { response: image(cached.bytes, cached.type) };
      }
    }
    if (!allow(userId, "media", mediaLimit, mediaWindowMs)) return { failure: rateLimited() };
    const gif = await find(id);
    if (!gif) return { failure: missing() };
    if (gif.failure) return { failure: gif.failure };
    if (size === "preview") {
      const { bytes, failure } = await download(gif.preview, PREVIEW_MAX_BYTES);
      if (failure) return { failure };
      const type = chatImageType(bytes);
      if (!PREVIEW_TYPES.has(type)) return { failure: unusable() };
      const prior = previews.get(id);
      if (prior) previewBytes -= prior.bytes.byteLength;
      remember(previews, id, { bytes, type }, Infinity);
      previewBytes += bytes.byteLength;
      while (previewBytes > PREVIEW_CACHE_BYTES && previews.size) {
        const [oldest, entry] = previews.entries().next().value;
        previews.delete(oldest);
        previewBytes -= entry.bytes.byteLength;
      }
      return { response: image(bytes, type) };
    }
    const { bytes, failure } = await download(gif.full, CHAT_ATTACHMENT.gif.bytes);
    if (failure) return { failure };
    if (chatImageType(bytes) !== "image/gif" || !readChatImage(bytes, "image/gif", CHAT_ATTACHMENT.gif)) return { failure: unusable() };
    return { response: image(bytes, "image/gif") };
  }

  return { search, media };
}
