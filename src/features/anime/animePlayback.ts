import { type AnimeIds, appendMegaPlayParams } from "./animeIdentity.ts";
import { isAnimeMovieFormat } from "./animeFields.ts";
import { seasonNumberFromTitle } from "./animeSeasons.ts";
import { appPath } from "../../core/runtime/hosting.ts";
import type { AnimeSeasonPart } from "./anime.ts";

export function episodeNumbersForCount(
  maxEpisode: number,
  initialEpisode = 0,
): number[] {
  const count = Math.max(maxEpisode || 0, initialEpisode || 0);
  return count > 0
    ? Array.from({ length: count }, (_, index) => index + 1)
    : [];
}

export function playableAnimeParts(
  parts: readonly AnimeSeasonPart[],
): AnimeSeasonPart[] {
  const end = parts.findIndex(
    (part) =>
      !Number.isInteger(part.episodeCount) || (part.episodeCount || 0) <= 0,
  );
  return parts.slice(0, end < 0 ? parts.length : end);
}

export interface AnimePlaybackUrlOptions {
  title: string;
  posterUrl: string;
  ids?: AnimeIds | undefined;
  episode: number;
  season?: number | undefined;
  sourceEpisode?: number | undefined;
  episodeCount?: number | undefined;
  year?: number | undefined;
  format?: string | undefined;
  language?: "sub" | "dub" | undefined;
  parts?: AnimeSeasonPart[] | undefined;
}

export function buildAnimePlaybackUrl({
  title,
  posterUrl,
  ids,
  episode,
  season,
  sourceEpisode,
  episodeCount,
  year,
  format,
  language = "sub",
  parts,
}: AnimePlaybackUrlOptions): string {
  const params = new URLSearchParams({
    title,
    poster: posterUrl,
    episode: String(episode),
    episodeName: `E${episode}`,
    language,
  });
  appendMegaPlayParams(params, ids);
  if (!isAnimeMovieFormat(format)) {
    params.set(
      "season",
      String(
        season !== undefined && Number.isInteger(season) && season > 0
          ? season
          : seasonNumberFromTitle(title) || 1,
      ),
    );
  }
  if (sourceEpisode && sourceEpisode > 0 && sourceEpisode !== episode) {
    params.set("source_episode", String(sourceEpisode));
  }
  if (parts && parts.length > 1) {
    let start = 1;
    const ranges = playableAnimeParts(parts).flatMap((part) => {
      const count = part.episodeCount || 0;
      if (count <= 0) return [];
      const range = { start, end: start + count - 1, ids: part.ids };
      start += count;
      return [range];
    });
    if (ranges.length > 1) params.set("episode_parts", JSON.stringify(ranges));
  }
  if (year) params.set("year", String(year));
  if (episodeCount && episodeCount > 0) {
    params.set("episode_count", String(episodeCount));
  }
  if (format) params.set("format", format);
  return `${appPath("/stream/anime")}?${params.toString()}`;
}
