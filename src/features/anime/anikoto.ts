import { normalizeAnimeIds, type AnimeIds } from "./animeIdentity.ts";
import { encodeMochiUrl } from "../../core/runtime/utils.ts";
import {
  classifyAnimeCategory,
  normalizeAnimeRating,
  getAudienceCacheKey,
} from "./animeFields.ts";
import { normalizeCatalogText } from "../../core/media/catalogSearch.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import type { AnimeEntry, AnimeEpisodeMapping } from "./anime.ts";

function deriveAnikotoEpisodeCount(record: {
  episodes?: number | string;
  next_air_ep?: number | string | null;
  status?: string;
}): {
  count?: number;
  source?: "anikoto" | "anikotoAiring";
} {
  const nextEpisode = Number(record.next_air_ep);
  if (Number.isInteger(nextEpisode) && nextEpisode > 1) {
    return { count: nextEpisode - 1, source: "anikotoAiring" };
  }
  if (record.next_air_ep != null) return {};
  const count = Number(record.episodes);
  if (Number.isInteger(count) && count > 0) {
    return { count, source: "anikoto" };
  }
  return {};
}

interface AnikotoAnimeRecord {
  id?: string | number;
  title?: string;
  alternative?: string;
  titles?: string;
  native?: string;
  poster?: string;
  background_image?: string;
  year?: number | string;
  episodes?: number | string;
  score?: number | string;
  status?: string;
  next_air_ep?: number | string | null;
  mal_id?: number | string;
  ani_id?: number | string;
  terms_by_type?: { type?: string[] };
}

interface AnikotoRecentResponse {
  data?: AnikotoAnimeRecord[];
}

interface AnikotoEpisodeRecord {
  number?: number | string;
  title?: string;
  episode_embed_id?: string | number;
  embed_url?: Record<string, string>;
}

interface AnikotoSeriesResponse {
  data?: { episodes?: AnikotoEpisodeRecord[] };
}

const ANIKOTO_API_URL = "https://anikotoapi.site";

const anikotoRecentCache = new Map<
  string,
  { expiresAt: number; entries: AnimeEntry[] }
>();
const anikotoRecentPromises = new Map<string, Promise<AnimeEntry[]>>();
const anikotoSeriesCache = new Map<
  string,
  { expiresAt: number; episodes: AnimeEpisodeMapping[] }
>();
const anikotoSeriesPromises = new Map<string, Promise<AnimeEpisodeMapping[]>>();

const ANIKOTO_RECENT_CACHE_TTL_MS = 30 * 60 * 1000;
const ANIKOTO_SERIES_CACHE_TTL_MS = 10 * 60 * 1000;

function parseProviderNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseEpisodeNumber(value: unknown, title = ""): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  const match = title.match(/\b(?:episode|ep\.?|e)\s*0*(\d+)\b/i);
  if (!match) return undefined;
  const fallback = Number(match[1]);
  return Number.isInteger(fallback) && fallback >= 0 ? fallback : undefined;
}

function splitAnikotoTitles(value?: string): string[] {
  return (value || "")
    .split(/[;\n]/)
    .map((title) => title.trim())
    .filter(Boolean);
}

function anikotoRecordToAnime(record: AnikotoAnimeRecord): AnimeEntry | null {
  const anikotoId = parseProviderNumber(record.id);
  const imageUrl = record.poster || record.background_image || "";
  const title = record.title?.trim() || splitAnikotoTitles(record.titles)[0];
  if (!anikotoId || !imageUrl || !title) return null;

  const titleVariants = [
    title,
    record.alternative,
    record.titles,
    record.native,
  ]
    .flatMap((value) => splitAnikotoTitles(value))
    .filter(Boolean);
  const ids = normalizeAnimeIds({
    anikoto: anikotoId,
    anilist: parseProviderNumber(record.ani_id),
    mal: parseProviderNumber(record.mal_id),
  });
  const year = parseProviderNumber(record.year);
  const episodeData = deriveAnikotoEpisodeCount(record);
  const format = record.terms_by_type?.type?.[0]?.toUpperCase();

  return {
    id: `anikoto:${anikotoId}`,
    title,
    year,
    posterUrl: `/!cover!/${encodeMochiUrl(imageUrl)}/`,
    backdropUrl: record.background_image
      ? `/!cover!/${encodeMochiUrl(record.background_image)}/`
      : undefined,
    animeType: "anime",
    category: classifyAnimeCategory(format, title),
    ids,
    anilistId: ids.anilist ? Number(ids.anilist) : undefined,
    malId: ids.mal ? Number(ids.mal) : undefined,
    format,
    rating: normalizeAnimeRating(record.score),
    episodeCount: episodeData.count,
    _episodeCountSource: episodeData.source,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: normalizeCatalogText(titleVariants.join(" ")),
  };
}

export async function fetchAnikotoRecentEntries(
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const cacheKey = getAudienceCacheKey();
  const cached = anikotoRecentCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  if (cached) anikotoRecentCache.delete(cacheKey);
  const existing = anikotoRecentPromises.get(cacheKey);
  if (existing) return existing;

  const url = `${ANIKOTO_API_URL}/recent-anime?page=1&per_page=50`;
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const promise = fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit)
    .then(async (response) => {
      if (!response.ok) {
        throw new RequestError("recent anime request failed", {
          code: "ANIME_RECENT_UNAVAILABLE",
          status: response.status,
        });
      }
      const payload = (await response.json()) as AnikotoRecentResponse;
      return (payload.data || [])
        .map(anikotoRecordToAnime)
        .filter((entry): entry is AnimeEntry => entry !== null);
    })
    .then((entries) => {
      anikotoRecentCache.set(cacheKey, {
        entries,
        expiresAt: Date.now() + ANIKOTO_RECENT_CACHE_TTL_MS,
      });
      return entries;
    })
    .catch((error) => {
      anikotoRecentPromises.delete(cacheKey);
      throw error;
    })
    .finally(() => {
      anikotoRecentPromises.delete(cacheKey);
    });
  anikotoRecentPromises.set(cacheKey, promise);
  return promise;
}

export async function fetchAnikotoEpisodes(
  ids: AnimeIds | undefined,
  signal?: AbortSignal,
): Promise<AnimeEpisodeMapping[]> {
  const anikotoId = normalizeAnimeIds(ids).anikoto;
  if (!anikotoId) return [];
  const cached = anikotoSeriesCache.get(anikotoId);
  if (cached && cached.expiresAt > Date.now()) return cached.episodes;
  if (cached) anikotoSeriesCache.delete(anikotoId);
  const existing = anikotoSeriesPromises.get(anikotoId);
  if (existing) return existing;

  const url = `${ANIKOTO_API_URL}/series/${encodeURIComponent(anikotoId)}`;
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const promise = fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit)
    .then(async (response) => {
      if (!response.ok) {
        throw new RequestError("anime episode request failed", {
          code: "ANIME_EPISODES_UNAVAILABLE",
          status: response.status,
        });
      }
      const payload = (await response.json()) as AnikotoSeriesResponse;
      return (payload.data?.episodes || [])
        .map((episode): AnimeEpisodeMapping | null => {
          const number = parseEpisodeNumber(episode.number, episode.title);
          if (number == null) return null;
          const episodeId = parseProviderNumber(episode.episode_embed_id);
          const languages = Object.keys(episode.embed_url || {}).filter(
            (language): language is "sub" | "dub" =>
              language === "sub" || language === "dub",
          );
          const mapping: AnimeEpisodeMapping = { number, languages };
          if (episode.title) mapping.title = episode.title;
          if (episodeId) mapping.anikotoEpisodeId = String(episodeId);
          return mapping;
        })
        .filter((episode): episode is AnimeEpisodeMapping => episode !== null)
        .sort((a, b) => a.number - b.number);
    })
    .then((episodes) => {
      anikotoSeriesCache.set(anikotoId, {
        episodes,
        expiresAt: Date.now() + ANIKOTO_SERIES_CACHE_TTL_MS,
      });
      return episodes;
    })
    .catch((error) => {
      anikotoSeriesPromises.delete(anikotoId);
      throw error;
    })
    .finally(() => {
      anikotoSeriesPromises.delete(anikotoId);
    });
  anikotoSeriesPromises.set(anikotoId, promise);
  return promise;
}

export function clearAnikotoCache(): void {
  anikotoRecentCache.clear();
  anikotoRecentPromises.clear();
  anikotoSeriesCache.clear();
  anikotoSeriesPromises.clear();
}
