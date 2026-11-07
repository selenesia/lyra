import { type AnimeIds, normalizeAnimeIds } from "./animeIdentity.ts";
import { fetchAnikotoEpisodes } from "./anikoto.ts";
import { fetchKitsuEpisodeCount } from "./kitsu.ts";
import { cacheKey } from "../../core/runtime/cacheNamespace.ts";

const ANIME_EPISODE_CACHE_KEY_PREFIX = "lyra-anime-episode-count";

export const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const _jikanEpsCache = new Map<string, { count: number; expiresAt: number }>();
const _jikanEpsPromises = new Map<string, Promise<number>>();

async function fetchIdentityEpisodeCount(ids: AnimeIds): Promise<number> {
  if (ids.mal) {
    try {
      const response = await fetch(
        `/api/anime/episodes/${encodeURIComponent(ids.mal)}?count_only=true`,
        {
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (response.ok) {
        const payload = (await response.json()) as { count?: number };
        if (Number.isInteger(payload.count) && (payload.count || 0) > 0)
          return payload.count!;
      }
    } catch {}
    return 0;
  }
  if (ids.anikoto) {
    const episodes = await fetchAnikotoEpisodes(ids).catch(() => []);
    if (episodes.length > 0) {
      return Math.max(1, ...episodes.map((episode) => episode.number));
    }
  }

  if (ids.kitsu) {
    const count = await fetchKitsuEpisodeCount(ids.kitsu).catch(() => 0);
    if (count > 0) return count;
  }

  const response = await fetch("/api/anime/identity/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) return 0;
  const identity = (await response.json()) as { episodes?: number };
  return Number.isInteger(identity.episodes) && (identity.episodes || 0) > 0
    ? identity.episodes || 0
    : 0;
}

export function chooseEpisodeCount(
  knownCount?: number,
  resolvedCount?: number,
): number {
  const known =
    Number.isInteger(knownCount) && (knownCount || 0) > 0 ? knownCount || 0 : 0;
  const resolved =
    Number.isInteger(resolvedCount) && (resolvedCount || 0) > 0
      ? resolvedCount || 0
      : 0;
  return resolved || known;
}

export async function fetchAnimeEpisodeCount(
  input: number | AnimeIds,
): Promise<number> {
  const ids = normalizeAnimeIds(
    typeof input === "number" ? { mal: input } : input,
  );
  const countIds = ids.mal ? { mal: ids.mal } : ids;
  const episodeIdentityKey = `identity:${JSON.stringify(Object.entries(countIds).sort())}`;
  const cached = _jikanEpsCache.get(episodeIdentityKey);
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  const storageKey = await cacheKey(
    ANIME_EPISODE_CACHE_KEY_PREFIX,
    import.meta.url,
    episodeIdentityKey,
  );
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null") as {
      count?: number;
      expiresAt?: number;
    } | null;
    if (
      stored &&
      Number.isInteger(stored.count) &&
      (stored.count || 0) > 0 &&
      (stored.expiresAt || 0) > Date.now()
    ) {
      const value = { count: stored.count!, expiresAt: stored.expiresAt! };
      _jikanEpsCache.set(episodeIdentityKey, value);
      return value.count;
    }
  } catch {}

  const inFlight = _jikanEpsPromises.get(episodeIdentityKey);
  if (inFlight) return inFlight;

  const promise = fetchIdentityEpisodeCount(ids)
    .then((count) => {
      if (Number.isInteger(count) && count > 0) {
        const value = { count, expiresAt: Date.now() + METADATA_CACHE_TTL_MS };
        _jikanEpsCache.set(episodeIdentityKey, value);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(value));
        } catch {}
      }
      return Number.isInteger(count) && count > 0 ? count : 0;
    })
    .catch(() => 0)
    .finally(() => {
      _jikanEpsPromises.delete(episodeIdentityKey);
    });
  _jikanEpsPromises.set(episodeIdentityKey, promise);
  return promise;
}

export function clearEpisodeCountCache(): void {
  _jikanEpsCache.clear();
  _jikanEpsPromises.clear();
}
