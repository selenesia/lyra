import { encodeMochiUrl } from "../../core/runtime/utils.ts";
import {
  getAdultAllowed,
  normalizeAnimeRating,
  classifyAnimeCategory,
} from "./animeFields.ts";
import { normalizeCatalogText } from "../../core/media/catalogSearch.ts";
import { normalizeAnimeIds } from "./animeIdentity.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import type { AnimeEntry } from "./anime.ts";

function deriveAniListEpisodeCount(
  media: Pick<AniListMedia, "episodes" | "status" | "nextAiringEpisode">,
): { count?: number; source?: "anilist" | "anilistAiring" } {
  if (Number.isInteger(media.episodes) && (media.episodes || 0) > 0) {
    return { count: media.episodes!, source: "anilist" };
  }
  const nextEpisode = media.nextAiringEpisode?.episode;
  if (Number.isInteger(nextEpisode) && (nextEpisode || 0) > 1) {
    return { count: (nextEpisode || 0) - 1, source: "anilistAiring" };
  }
  if (media.nextAiringEpisode) return {};
  return {};
}

interface AniListMedia {
  id: number;
  idMal?: number;
  title: { english?: string; romaji?: string; native?: string };
  coverImage: { large?: string; medium?: string };
  averageScore?: number;
  seasonYear?: number;
  startDate?: { year?: number };
  isAdult?: boolean;
  format?: string;
  status?: string;
  episodes?: number;
  nextAiringEpisode?: { episode?: number };
}

interface AniListResponse {
  data?: { Page?: { media?: AniListMedia[] } };
}

const ANILIST_URL = `/!!/${encodeMochiUrl("https://graphql.anilist.co")}/`;

export const ANILIST_MEDIA_FIELDS = `
  id
  idMal
  title { english romaji native }
  coverImage { large medium }
  averageScore
  seasonYear
  startDate { year }
  isAdult
  format
  status
  episodes
  nextAiringEpisode { episode }
`;

function mediaToAnimeEntry(media: AniListMedia): AnimeEntry | null {
  const imageUrl = media.coverImage?.large || media.coverImage?.medium || "";
  if (!imageUrl) return null;
  if (!getAdultAllowed() && media.isAdult) return null;

  const title =
    media.title?.english ||
    media.title?.romaji ||
    media.title?.native ||
    "unknown";
  const titleSearchText = normalizeCatalogText(
    [media.title?.english, media.title?.romaji, media.title?.native]
      .filter(Boolean)
      .join(" "),
  );
  const aniListEpisodeData = deriveAniListEpisodeCount(media);
  const entry: AnimeEntry = {
    id: media.id,
    title,
    year: media.startDate?.year || media.seasonYear,
    _metadataSource: "anilist",
    posterUrl: `/!cover!/${encodeMochiUrl(imageUrl)}/`,
    posterSmallUrl: media.coverImage?.medium
      ? `/!cover!/${encodeMochiUrl(media.coverImage.medium)}/`
      : undefined,
    rating: normalizeAnimeRating(media.averageScore),
    animeType: "anime",
    category: classifyAnimeCategory(media.format, title),
    adult: media.isAdult ?? false,
    ids: normalizeAnimeIds({
      anilist: media.id,
      mal: media.idMal,
    }),
    anilistId: media.id,
    malId: media.idMal,
    format: media.format,
    episodeCount: aniListEpisodeData.count,
    _episodeCountSource: aniListEpisodeData.source,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: titleSearchText,
  };
  return entry;
}

export async function fetchAniListEntries(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  };
  if (signal) requestInit.signal = signal;
  const response = await fetch(ANILIST_URL, requestInit);
  if (!response.ok) {
    throw new RequestError("anime catalog request failed", {
      code: "ANIME_CATALOG_UNAVAILABLE",
      status: response.status,
    });
  }

  const payload = (await response.json()) as AniListResponse;
  return (payload.data?.Page?.media || [])
    .map(mediaToAnimeEntry)
    .filter((entry): entry is AnimeEntry => entry !== null);
}
