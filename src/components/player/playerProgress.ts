import type { MutableRef } from "preact/hooks";
import { cleanDuration } from "./playerState.ts";
import type { PlaybackEpisodePartRange } from "./episodeParts.ts";
import { saveAnimeProgress } from "../../features/anime/animeProgress.ts";
import {
  type AnimeProvider,
  normalizeAnimeIds,
} from "../../features/anime/animeIdentity.ts";

interface ProgressContext {
  title: string;
  poster: string;
  identityIds: Partial<Record<AnimeProvider, string>>;
  activeAnikotoEpisodeId: string;
  episodeNumber: number;
  sourceEpisodeNumber: number;
  params: URLSearchParams;
  episodeCountRef: MutableRef<number>;
  format: string;
  language: "sub" | "dub";
  episodeParts: PlaybackEpisodePartRange[];
  resumeKey: string;
}

export function persistPlayerProgress({
  title, poster, identityIds, activeAnikotoEpisodeId, episodeNumber,
  sourceEpisodeNumber, params, episodeCountRef, format, language, episodeParts,
  resumeKey,
}: ProgressContext, currentTime: number, duration: number, completed = false) {
    saveAnimeProgress(
      {
        title,
        posterUrl: poster,
        ids: normalizeAnimeIds({
          ...identityIds,
          anikotoEpisode: activeAnikotoEpisodeId || undefined,
        }),
        episode: episodeNumber,
        sourceEpisode: sourceEpisodeNumber,
        season: Number(params.get("season")) || 1,
        episodeCount: episodeCountRef.current,
        year: Number(params.get("year")) || undefined,
        format,
        language,
        parts: episodeParts.map((part) => ({
          id: part.start,
          title,
          ids: part.ids,
          episodeCount: part.end - part.start + 1,
        })),
        currentTime,
        duration: cleanDuration(duration),
        completed,
        updatedAt: Date.now(),
      },
      resumeKey,
    );
  }
