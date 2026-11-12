import { readAnimeQuality } from "../../core/media/animeSettings.ts";
import {
  appendTitleStreamParams,
  isWatchLanguage,
  parseTitlePlayback,
  readWatchLanguage,
} from "./watchPlayback.ts";

const PREWARM_TTL_MS = 5 * 60 * 1000;
const PREWARM_TIMEOUT_MS = 20_000;
const prewarmed = new Map<string, number>();

export function titlePrewarmQuery(
  playerUrl: string,
  origin: string,
): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(playerUrl, origin).searchParams;
  } catch {
    return null;
  }
  const playback = parseTitlePlayback(params);
  if (!playback) return null;
  const episode = Number(params.get("episode") || 1);
  const language = params.get("language");
  const quality = readAnimeQuality();
  const query = new URLSearchParams({
    episode: String(episode),
    language: isWatchLanguage(language) ? language : readWatchLanguage(),
    session: "prewarm",
  });
  if (quality === "auto" || quality === "2160p") {
    query.set("preferred_quality", "auto");
  }
  return appendTitleStreamParams(query, playback, episode) ? query : null;
}

export function prewarmTitlePlayback(playerUrl: string): void {
  const query = titlePrewarmQuery(playerUrl, window.location.origin);
  if (!query) return;
  const key = query.toString();
  const now = Date.now();
  for (const [stale, startedAt] of prewarmed) {
    if (now - startedAt > PREWARM_TTL_MS) prewarmed.delete(stale);
  }
  if (prewarmed.has(key)) return;
  prewarmed.set(key, now);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS);
  void fetch(`/stream/info?${key}`, { signal: controller.signal })
    .then((response) => {
      if (!response.ok) prewarmed.delete(key);
      return response.body?.cancel();
    })
    .catch(() => {
      prewarmed.delete(key);
    })
    .finally(() => window.clearTimeout(timeout));
}
