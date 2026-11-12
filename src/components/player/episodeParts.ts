import {
  type AnimeIds,
  normalizeAnimeIds,
  hasMegaPlayIdentifier,
  appendMegaPlayParams,
} from "../../features/anime/animeIdentity.ts";

export interface PlaybackEpisodePartRange {
  start: number;
  end: number;
  ids: AnimeIds;
}

export function mergeEpisodeCount(...counts: number[]): number {
  return counts.reduce(
    (largest, count) =>
      Number.isInteger(count) && count > largest ? count : largest,
    0,
  );
}

export function parsePlaybackEpisodeParts(
  value: string | null,
): PlaybackEpisodePartRange[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as {
        start?: unknown;
        end?: unknown;
        ids?: unknown;
      };
      const start = Number(candidate.start);
      const end = Number(candidate.end);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        !candidate.ids ||
        typeof candidate.ids !== "object"
      ) {
        return [];
      }
      return [
        { start, end, ids: normalizeAnimeIds(candidate.ids as AnimeIds) },
      ];
    });
  } catch {
    return [];
  }
}

export function buildNextEpisodeStreamUrl(
  episode: number,
  episodeParts: PlaybackEpisodePartRange[],
  identityIds: AnimeIds,
  language: "sub" | "dub",
  session: string,
  qualityRequest: string,
  provider: string,
): string {
  const part = episodeParts.find(
    (candidate) => episode >= candidate.start && episode <= candidate.end,
  );
  const sourceEpisode = part ? episode - part.start + 1 : episode;
  const ids = normalizeAnimeIds({
    ...(part?.ids || identityIds),
    anikotoEpisode: undefined,
  });
  if (!hasMegaPlayIdentifier(ids)) return "";
  const query = new URLSearchParams({
    episode: String(sourceEpisode),
    language,
    session,
  });
  if (qualityRequest) query.set("preferred_quality", qualityRequest);
  appendMegaPlayParams(query, ids);
  if (provider) query.set("provider", provider);
  return `/stream/anikoto?${query}`;
}
