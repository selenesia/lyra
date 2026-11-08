import type { MutableRef } from "preact/hooks";
import { cleanDuration } from "./playerState.ts";
import type { PlaybackEpisodePartRange } from "./episodeParts.ts";
import { saveAnimeProgress } from "../../features/anime/animeProgress.ts";
import { saveWatchProgress } from "../../features/watch/watchProgress.ts";
import type { TitlePlayback } from "../../features/watch/watchPlayback.ts";
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
  language: string;
  episodeParts: PlaybackEpisodePartRange[];
  resumeKey: string;
  titlePlayback: TitlePlayback | null;
}

export function persistPlayerProgress({
  title, poster, identityIds, activeAnikotoEpisodeId, episodeNumber,
  sourceEpisodeNumber, params, episodeCountRef, format, language, episodeParts,
  resumeKey, titlePlayback,
}: ProgressContext, currentTime: number, duration: number, completed = false) {
    const year = Number(params.get("year")) || undefined;
    if (titlePlayback) {
      saveWatchProgress(
        {
          ...titlePlayback,
          title,
          posterUrl: poster,
          episode: titlePlayback.type === "tv" ? episodeNumber : undefined,
          episodeCount: titlePlayback.type === "tv" && episodeCountRef.current > 0 ? episodeCountRef.current : undefined,
          year,
          language,
          currentTime,
          duration: cleanDuration(duration),
          completed,
          updatedAt: Date.now(),
        },
        resumeKey,
      );
      return;
    }
    if (language !== "sub" && language !== "dub") return;
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
        year,
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
