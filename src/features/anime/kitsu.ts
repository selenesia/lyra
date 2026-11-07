import { normalizeAnimeIds } from "./animeIdentity.ts";
import { encodeMochiUrl } from "../../core/runtime/utils.ts";
import { normalizeAnimeRating, classifyAnimeCategory } from "./animeFields.ts";
import { normalizeCatalogText } from "../../core/media/catalogSearch.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import type { AnimeEntry } from "./anime.ts";

interface KitsuAnimeResource {
  id: string;
  attributes?: {
    canonicalTitle?: string;
    titles?: Record<string, string>;
    startDate?: string;
    subtype?: string;
    averageRating?: string;
    episodeCount?: number;
    posterImage?: { large?: string; medium?: string };
  };
  relationships?: {
    mappings?: { data?: Array<{ id: string }> };
  };
}

interface KitsuMappingResource {
  id: string;
  attributes?: {
    externalSite?: string;
    externalId?: string;
  };
}

interface KitsuAnimeResponse {
  data?: KitsuAnimeResource[];
  included?: KitsuMappingResource[];
}

function kitsuResourceToAnime(
  resource: KitsuAnimeResource,
  mappings: Map<string, KitsuMappingResource>,
): AnimeEntry | null {
  const attributes = resource.attributes;
  const poster =
    attributes?.posterImage?.large || attributes?.posterImage?.medium || "";
  if (!poster) return null;
  const titles = attributes?.titles || {};
  const title =
    titles.en ||
    titles.en_us ||
    attributes?.canonicalTitle ||
    titles.en_jp ||
    titles.ja_jp ||
    "unknown";
  const year = Number.parseInt(attributes?.startDate?.slice(0, 4) || "", 10);
  const rating = Number.parseFloat(attributes?.averageRating || "");
  const ids = normalizeAnimeIds({ kitsu: resource.id });
  for (const mappingRef of resource.relationships?.mappings?.data || []) {
    const mapping = mappings.get(mappingRef.id);
    const site = mapping?.attributes?.externalSite?.toLowerCase();
    const id = mapping?.attributes?.externalId;
    if (!id) continue;
    if (site === "anilist/anime") ids.anilist ||= id;
    if (site === "myanimelist/anime") ids.mal ||= id;
  }
  return {
    id: resource.id,
    title,
    year: Number.isFinite(year) ? year : undefined,
    posterUrl: `/!cover!/${encodeMochiUrl(poster)}/`,
    posterSmallUrl: attributes?.posterImage?.medium
      ? `/!cover!/${encodeMochiUrl(attributes.posterImage.medium)}/`
      : undefined,
    rating: normalizeAnimeRating(rating),
    animeType: "anime",
    category: classifyAnimeCategory(attributes?.subtype, title),
    ids,
    anilistId: ids.anilist ? Number(ids.anilist) : undefined,
    malId: ids.mal ? Number(ids.mal) : undefined,
    format: attributes?.subtype?.toUpperCase(),
    episodeCount: attributes?.episodeCount,
    _metadataSource: "kitsu",
    _episodeCountSource: attributes?.episodeCount != null ? "kitsu" : undefined,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: normalizeCatalogText(
      [title, titles.en, titles.en_jp, titles.ja_jp].filter(Boolean).join(" "),
    ),
  };
}

async function fetchKitsuAnimeList(
  url: string,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const response = await fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit);
  if (!response.ok) {
    throw new RequestError("anime catalog request failed", {
      code: "ANIME_CATALOG_UNAVAILABLE",
      status: response.status,
    });
  }
  const json = (await response.json()) as KitsuAnimeResponse;
  const mappings = new Map(
    (json.included || []).map((mapping) => [mapping.id, mapping]),
  );
  return (json.data || [])
    .map((resource) => kitsuResourceToAnime(resource, mappings))
    .filter((entry): entry is AnimeEntry => entry !== null);
}

const KITSU_API_URL = "https://kitsu.io/api/edge";

export async function fetchKitsuEntries(
  query: string,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const url =
    `${KITSU_API_URL}/anime?filter[text]=${encodeURIComponent(query)}` +
    "&page[limit]=20&include=mappings";
  return fetchKitsuAnimeList(url, signal);
}

export async function fetchKitsuTrendingEntries(
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const url =
    `${KITSU_API_URL}/anime?filter[status]=current&sort=-userCount` +
    "&page[limit]=20&include=mappings";
  return fetchKitsuAnimeList(url, signal);
}

export async function fetchKitsuEpisodeCount(kitsuId: string): Promise<number> {
  const url = `${KITSU_API_URL}/anime/${encodeURIComponent(kitsuId)}`;
  const response = await fetch(`/!!/${encodeMochiUrl(url)}/`);
  if (!response.ok) return 0;
  const payload = (await response.json()) as { data?: KitsuAnimeResource };
  const count = payload.data?.attributes?.episodeCount;
  return Number.isInteger(count) && (count || 0) > 0 ? count! : 0;
}
