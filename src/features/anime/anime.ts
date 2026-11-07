import { cacheKey } from "../../core/runtime/cacheNamespace.ts";
import {
  catalogMatchRank,
  normalizeCatalogText,
} from "../../core/media/catalogSearch.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import {
  resetAnimeIdentityCache,
  type AnimeIds,
} from "./animeIdentity.ts";
import { getAudienceCacheKey, applySearchFields } from "./animeFields.ts";
import { ANILIST_MEDIA_FIELDS, fetchAniListEntries } from "./anilist.ts";
import { fetchKitsuTrendingEntries, fetchKitsuEntries } from "./kitsu.ts";
import { fetchAnikotoRecentEntries, clearAnikotoCache } from "./anikoto.ts";
import { mergeAnimeEntries } from "./animeSeasons.ts";
import {
  METADATA_CACHE_TTL_MS,
  clearEpisodeCountCache,
} from "./animeEpisodes.ts";
export { fetchAnikotoEpisodes } from "./anikoto.ts";
export { isAnimeMovieFormat } from "./animeFields.ts";
export { chooseEpisodeCount, fetchAnimeEpisodeCount } from "./animeEpisodes.ts";
export {
  buildAnimePlaybackUrl,
  episodeNumbersForCount,
  playableAnimeParts,
  type AnimePlaybackUrlOptions,
} from "./animePlayback.ts";
export { mergeAnimeEntries } from "./animeSeasons.ts";

export interface AnimeEntry {
  id: string | number;
  title: string;
  year?: number | undefined;
  posterUrl: string;
  posterSmallUrl?: string | undefined;
  backdropUrl?: string | undefined;
  rating?: number | undefined;
  overview?: string | undefined;
  animeType: "anime";
  genres?: string[] | undefined;
  adult?: boolean | undefined;
  category?: AnimeEntryCategory | undefined;

  ids?: AnimeIds | undefined;
  seasons?: AnimeSeason[] | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  format?: string | undefined;
  episodeCount?: number | undefined;
  _metadataSource?: "anilist" | "jikan" | "kitsu" | "anikoto" | undefined;
  _episodeCountSource?:
    | "anikoto"
    | "anikotoAiring"
    | "anilist"
    | "anilistAiring"
    | "kitsu"
    | "jikan"
    | undefined;
  _normalizedTitle?: string | undefined;
  _searchText?: string | undefined;
}

export type AnimeEntryCategory =
  | "main-season"
  | "movie"
  | "ova"
  | "ona"
  | "special"
  | "recap"
  | "spin-off"
  | "side-story"
  | "music"
  | "unknown";

export interface AnimeSeasonPart {
  id: string | number;
  title: string;
  year?: number | undefined;
  number?: number | undefined;
  ids: AnimeIds;
  episodeCount?: number | undefined;
  _episodeCountSource?: AnimeEntry["_episodeCountSource"];
  _metadataSource?: AnimeEntry["_metadataSource"];
}

export interface AnimeSeason {
  id: string | number;
  title: string;
  year?: number | undefined;
  number?: number | undefined;
  ids: AnimeIds;
  category?: AnimeEntryCategory | undefined;
  format?: string | undefined;
  episodeCount?: number | undefined;
  _metadataSource?: AnimeEntry["_metadataSource"];
  _episodeCountSource?:
    | "anikoto"
    | "anikotoAiring"
    | "anilist"
    | "anilistAiring"
    | "kitsu"
    | "jikan"
    | undefined;
  relationType?: string | undefined;
  parts?: AnimeSeasonPart[] | undefined;
}

export type AnimeCategory = "trending" | "anime";

export interface AnimeEpisodeMapping {
  number: number;
  title?: string;
  anikotoEpisodeId?: string;
  languages: Array<"sub" | "dub">;
}
type AnimeFeedSubscriber = (anime: AnimeEntry[]) => void;

interface AnimeFeedRequest {
  promise: Promise<AnimeEntry[]>;
  latest: AnimeEntry[];
  subscribers: Set<AnimeFeedSubscriber>;
}

interface AnimeSearchRequest extends AnimeFeedRequest {
  controller: AbortController;
  consumers: number;
}

const animeFeedRequests = new Map<string, AnimeFeedRequest>();
let animeFeedGeneration = 0;
const sortedAnimePromises = new Map<string, Promise<AnimeEntry[]>>();
const sortedAnimeCache = new Map<string, StoredAnimeFeed>();
const searchAnimeRequests = new Map<string, AnimeSearchRequest>();
const ANIME_FEED_CACHE_KEY_PREFIX = "lyra-anime-feed-entries";
const ANIME_SEARCH_CACHE_KEY_PREFIX = "lyra-anime-search-entries";
const ANIME_FEED_CACHE_TTL_MS = 30 * 60 * 1000;

interface StoredAnimeFeed {
  anime: AnimeEntry[];
  expiresAt: number;
}

function fetchAniListSorted(sort: "TRENDING_DESC" | "POPULARITY_DESC") {
  const cacheKey = `${sort}:${getAudienceCacheKey()}`;
  const cached = sortedAnimeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.anime);
  }
  if (cached) sortedAnimeCache.delete(cacheKey);
  const inFlight = sortedAnimePromises.get(cacheKey);
  if (inFlight) return inFlight;
  const generation = animeFeedGeneration;

  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        media(sort: ${sort}, type: ANIME) {
          ${ANILIST_MEDIA_FIELDS}
        }
      }
    }
  `;

  const promise = fetchAniListEntries(query, { page: 1 })
    .then((anime) => {
      if (generation === animeFeedGeneration) {
        sortedAnimeCache.set(cacheKey, {
          anime,
          expiresAt: Date.now() + ANIME_FEED_CACHE_TTL_MS,
        });
      }
      return anime;
    })
    .finally(() => {
      if (sortedAnimePromises.get(cacheKey) === promise) {
        sortedAnimePromises.delete(cacheKey);
      }
    });
  sortedAnimePromises.set(cacheKey, promise);
  return promise;
}

async function fetchTrendingAnimeEntries(): Promise<AnimeEntry[]> {
  const anilistTrending = await fetchAniListSorted("TRENDING_DESC").catch(
    () => [] as AnimeEntry[],
  );
  if (anilistTrending.length > 0) return anilistTrending;
  return fetchKitsuTrendingEntries().catch(() => [] as AnimeEntry[]);
}

function getCacheKey(category: AnimeCategory): Promise<string> {
  return cacheKey(
    ANIME_FEED_CACHE_KEY_PREFIX,
    import.meta.url,
    `${category === "trending" ? "trending-anilist" : category}-${getAudienceCacheKey()}`,
  );
}

export function searchAnimeLocally(
  anime: readonly AnimeEntry[],
  query: string,
): AnimeEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return anime as AnimeEntry[];

  const tokens = normalizedQuery.split(" ");
  const ranked: AnimeEntry[][] = [[], [], [], [], []];
  for (const entry of anime) {
    const rank = catalogMatchRank(
      entry._normalizedTitle ?? normalizeCatalogText(entry.title),
      entry._searchText || "",
      normalizedQuery,
      tokens,
    );
    if (rank >= 0) ranked[rank]!.push(entry);
  }
  return ranked.flat();
}

function filterAnimeSearchResults(
  anime: readonly AnimeEntry[],
  query: string,
): AnimeEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return anime as AnimeEntry[];
  const tokens = normalizedQuery.split(" ");
  return anime.filter(
    (entry) =>
      catalogMatchRank(
        entry._normalizedTitle ?? normalizeCatalogText(entry.title),
        entry._searchText || "",
        normalizedQuery,
        tokens,
      ) >= 0,
  );
}

function saveToCacheKey(cacheKey: string, anime: AnimeEntry[]): AnimeEntry[] {
  try {
    const stored: StoredAnimeFeed = {
      anime,
      expiresAt: Date.now() + ANIME_FEED_CACHE_TTL_MS,
    };
    localStorage.setItem(cacheKey, JSON.stringify(stored));
  } catch {}
  return anime;
}

export async function fetchAnimeData(
  category: AnimeCategory,
  onUpdate?: AnimeFeedSubscriber,
): Promise<AnimeEntry[]> {
  const generation = animeFeedGeneration;
  const cacheKey = await getCacheKey(category);
  if (generation !== animeFeedGeneration) return [];
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const stored = JSON.parse(cached) as StoredAnimeFeed;
      if (
        stored.expiresAt > Date.now() &&
        Array.isArray(stored.anime) &&
        stored.anime.length > 0
      ) {
        const anime = applySearchFields(stored.anime);
        try {
          onUpdate?.(anime);
        } catch {}
        return anime;
      }
      localStorage.removeItem(cacheKey);
    }
  } catch {}

  const inFlight = animeFeedRequests.get(cacheKey);
  if (inFlight) {
    if (inFlight.latest.length > 0) {
      try {
        onUpdate?.(inFlight.latest);
      } catch {}
    }
    if (!onUpdate) return inFlight.promise;
    inFlight.subscribers.add(onUpdate);
    return inFlight.promise.finally(() => {
      inFlight.subscribers.delete(onUpdate);
    });
  }

  const request: AnimeFeedRequest = {
    promise: Promise.resolve([]),
    latest: [],
    subscribers: new Set(onUpdate ? [onUpdate] : []),
  };

  const promise = (async () => {
    let providers: Array<() => Promise<AnimeEntry[]>>;

    switch (category) {
      case "trending":
        providers = [() => fetchAniListSorted("TRENDING_DESC")];
        break;
      case "anime":
        providers = [
          fetchTrendingAnimeEntries,
          () => fetchAniListSorted("POPULARITY_DESC"),
          fetchAnikotoRecentEntries,
        ];
        break;
      default:
        providers = [];
    }

    const providerResults: Array<AnimeEntry[] | undefined> = Array.from({
      length: providers.length,
    });
    await Promise.all(
      providers.map((fetchProvider, index) =>
        fetchProvider()
          .catch(() => [] as AnimeEntry[])
          .then((anime) => {
            if (generation !== animeFeedGeneration) return;
            providerResults[index] = anime;
            if (anime.length === 0) return;
            request.latest = mergeAnimeEntries(
              ...providerResults.map((results) => results || []),
            );
            for (const subscriber of request.subscribers) {
              try {
                subscriber(request.latest);
              } catch {}
            }
          }),
      ),
    );

    const anime = request.latest;
    if (generation !== animeFeedGeneration) return [];
    if (anime.length === 0) {
      throw new RequestError("failed to fetch anime data", {
        code: "ANIME_CATALOG_UNAVAILABLE",
      });
    }
    return saveToCacheKey(cacheKey, anime);
  })().finally(() => {
    if (animeFeedRequests.get(cacheKey) === request) {
      animeFeedRequests.delete(cacheKey);
    }
  });

  request.promise = promise;
  animeFeedRequests.set(cacheKey, request);
  return promise.finally(() => {
    if (onUpdate) request.subscribers.delete(onUpdate);
  });
}

function subscribeAnimeSearch(
  cacheKey: string,
  request: AnimeSearchRequest,
  signal?: AbortSignal,
  onUpdate?: AnimeFeedSubscriber,
): Promise<AnimeEntry[]> {
  request.consumers += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const publish = (anime: AnimeEntry[]) => {
      try {
        onUpdate?.(anime);
      } catch {}
    };
    const release = () => {
      if (finished) return false;
      finished = true;
      request.consumers -= 1;
      request.subscribers.delete(publish);
      signal?.removeEventListener("abort", abort);
      return true;
    };
    const abort = () => {
      if (!release()) return;
      reject(
        new DOMException("anime request aborted... /ᐠ - ˕ -マ", "AbortError"),
      );
      if (request.consumers === 0) {
        request.controller.abort();
        if (searchAnimeRequests.get(cacheKey) === request) {
          searchAnimeRequests.delete(cacheKey);
        }
      }
    };
    request.subscribers.add(publish);
    signal?.addEventListener("abort", abort, { once: true });
    request.promise.then(
      (anime) => {
        if (release()) resolve(anime);
      },
      (error) => {
        if (release()) reject(error);
      },
    );
    if (signal?.aborted) abort();
    else if (request.latest.length > 0) publish(request.latest);
  });
}

export async function searchAnime(
  query: string,
  signal?: AbortSignal,
  onUpdate?: (results: AnimeEntry[]) => void,
  options: { forceRefresh?: boolean } = {},
): Promise<AnimeEntry[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  signal?.throwIfAborted();
  const generation = animeFeedGeneration;
  const forceRefresh = options.forceRefresh === true;

  const searchCacheKey = await cacheKey(
    ANIME_SEARCH_CACHE_KEY_PREFIX,
    import.meta.url,
    `${getAudienceCacheKey()}-${trimmed.toLowerCase()}`,
  );
  signal?.throwIfAborted();
  if (generation !== animeFeedGeneration) return [];
  try {
    if (!forceRefresh && typeof sessionStorage !== "undefined") {
      const cached = sessionStorage.getItem(searchCacheKey);
      if (cached) {
        const stored = JSON.parse(cached) as {
          expiresAt?: number;
          results?: AnimeEntry[];
        };
        if (
          (stored.expiresAt || 0) > Date.now() &&
          Array.isArray(stored.results)
        ) {
          const results = applySearchFields(stored.results);
          onUpdate?.(results);
          return results;
        }
      }
    }
  } catch {}

  const inFlight = searchAnimeRequests.get(searchCacheKey);
  if (inFlight && !forceRefresh) {
    return subscribeAnimeSearch(searchCacheKey, inFlight, signal, onUpdate);
  }

  const request: AnimeSearchRequest = {
    promise: Promise.resolve([]),
    latest: [],
    subscribers: new Set(),
    controller: new AbortController(),
    consumers: 0,
  };
  const requestSignal = request.controller.signal;

  const anilistQuery = `
    query ($search: String) {
      Page(page: 1, perPage: 25) {
        media(search: $search, type: ANIME) {
          ${ANILIST_MEDIA_FIELDS}
        }
      }
    }
  `;

  let results: AnimeEntry[] = [];
  const publish = (providerResults: AnimeEntry[]) => {
    if (requestSignal.aborted || generation !== animeFeedGeneration) return;
    const filtered = filterAnimeSearchResults(providerResults, trimmed);
    if (filtered.length === 0) return;
    results = mergeAnimeEntries(results, filtered);
    request.latest = results;
    for (const subscriber of request.subscribers) subscriber(results);
  };

  const promise = Promise.all([
    fetchAniListEntries(anilistQuery, { search: trimmed }, requestSignal)
      .then((providerResults) => publish(providerResults))
      .catch((error) => {
        if (requestSignal.aborted) throw error;
      }),
    fetchKitsuEntries(trimmed, requestSignal)
      .then((providerResults) => publish(providerResults))
      .catch((error) => {
        if (requestSignal.aborted) throw error;
      }),
  ])
    .then(() => {
      if (requestSignal.aborted) {
        throw new DOMException(
          "anime request aborted... /ᐠ - ˕ -マ",
          "AbortError",
        );
      }
      if (generation !== animeFeedGeneration) return [];
      try {
        if (
          results.length > 0 &&
          searchAnimeRequests.get(searchCacheKey) === request &&
          typeof sessionStorage !== "undefined"
        ) {
          sessionStorage.setItem(
            searchCacheKey,
            JSON.stringify({
              results,
              expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
            }),
          );
        }
      } catch {}
      return results;
    })
    .finally(() => {
      if (searchAnimeRequests.get(searchCacheKey) === request) {
        searchAnimeRequests.delete(searchCacheKey);
      }
    });

  request.promise = promise;
  searchAnimeRequests.set(searchCacheKey, request);
  return subscribeAnimeSearch(searchCacheKey, request, signal, onUpdate);
}

export function resetAnimeCache(): void {
  animeFeedGeneration += 1;
  for (const request of animeFeedRequests.values()) {
    request.subscribers.clear();
  }
  animeFeedRequests.clear();
  sortedAnimePromises.clear();
  sortedAnimeCache.clear();
  for (const request of searchAnimeRequests.values()) {
    request.controller.abort();
  }
  searchAnimeRequests.clear();
  clearAnikotoCache();
  clearEpisodeCountCache();
  resetAnimeIdentityCache();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("lyra-anime-")) sessionStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("lyra-anime-feed-")) localStorage.removeItem(key);
    }
  } catch {}
}
