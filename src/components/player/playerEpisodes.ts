import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import type { PlayerSelector } from "./playerState.ts";
import {
  mergeEpisodeCount,
  type PlaybackEpisodePartRange,
} from "./episodeParts.ts";
import {
  type AnimeProvider,
  appendMegaPlayParams,
} from "../../features/anime/animeIdentity.ts";
import {
  type AnimeSeason,
  fetchAnimeEpisodeCount,
  isAnimeMovieFormat,
} from "../../features/anime/anime.ts";
import type {
  MediaState,
  MediaStateHints,
} from "../../core/media/mediaState.ts";
import {
  readAnimeSetting,
  ANIME_SETTING_KEYS,
} from "../../core/media/animeSettings.ts";

interface EpisodeChangeContext {
  episodeNumber: number;
  episodeCount: number;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  clearAutoNext: () => void;
  videoRef: MutableRef<HTMLVideoElement | null>;
  sourceContextGenerationRef: MutableRef<number>;
  languageRequestRef: MutableRef<AbortController | null>;
  setChangingLanguage: Dispatch<StateUpdater<boolean>>;
  playIntentRef: MutableRef<boolean>;
  currentTimeRef: MutableRef<number | null>;
  persistProgress: (currentTime: number, duration: number, completed?: boolean) => void;
  mediaStateRef: MutableRef<MediaState>;
  playAfterSeekRef: MutableRef<boolean>;
  syncMediaState: (patch?: MediaStateHints) => void;
  setConfirmedEpisodeNumber: Dispatch<StateUpdater<number | null>>;
  setEpisodeNumber: Dispatch<StateUpdater<number>>;
  setLanguage: Dispatch<StateUpdater<string>>;
  nextAudioLanguageRef: MutableRef<string>;
  setActiveAnikotoEpisodeId: Dispatch<StateUpdater<string>>;
  episodeParts: PlaybackEpisodePartRange[];
  setActivePartRange: Dispatch<StateUpdater<PlaybackEpisodePartRange | null>>;
  setActivePartIds: Dispatch<StateUpdater<Partial<Record<AnimeProvider, string>>>>;
  identityIds: Partial<Record<AnimeProvider, string>>;
  setEpisodeOffset: Dispatch<StateUpdater<number>>;
  currentSeason: AnimeSeason;
}

export function changePlayerEpisode({
  episodeNumber, episodeCount, setOpenSelector, clearAutoNext, videoRef,
  sourceContextGenerationRef, languageRequestRef, setChangingLanguage,
  playIntentRef, currentTimeRef, persistProgress, mediaStateRef,
  playAfterSeekRef, syncMediaState, setConfirmedEpisodeNumber, setEpisodeNumber,
  setLanguage, nextAudioLanguageRef, setActiveAnikotoEpisodeId, episodeParts,
  setActivePartRange, setActivePartIds, identityIds, setEpisodeOffset,
  currentSeason,
}: EpisodeChangeContext, nextEpisode: number, autoplay = false) {
    if (
      nextEpisode === episodeNumber ||
      nextEpisode < 1 ||
      (episodeCount > 0 && nextEpisode > episodeCount)
    ) {
      setOpenSelector(null);
      return;
    }

    clearAutoNext();
    const video = videoRef.current;
    sourceContextGenerationRef.current += 1;
    languageRequestRef.current?.abort();
    languageRequestRef.current = null;
    setChangingLanguage(false);
    const shouldKeepPlaying =
      autoplay ||
      Boolean(video && !video.paused && !video.ended) ||
      playIntentRef.current;
    const resumeTime = video
      ? video.currentTime
      : (currentTimeRef.current ?? 0);
    if (resumeTime > 0) {
      persistProgress(
        resumeTime,
        mediaStateRef.current.duration || 0,
        video?.ended,
      );
    }

    playIntentRef.current = shouldKeepPlaying;
    playAfterSeekRef.current = shouldKeepPlaying;
    if (video && !shouldKeepPlaying) video.pause();
    syncMediaState({
      sourceReady: false,
      buffering: true,
      bufferingReason: "waiting",
      error: null,
      durationHint: null,
      logicalOffset: 0,
    });
    setOpenSelector(null);
    setConfirmedEpisodeNumber(null);
    setEpisodeNumber(nextEpisode);
    setLanguage(nextAudioLanguageRef.current);
    setActiveAnikotoEpisodeId("");
    const nextPart = episodeParts.find(
      (part) => nextEpisode >= part.start && nextEpisode <= part.end,
    );
    setActivePartRange(nextPart || null);
    setActivePartIds(nextPart?.ids || identityIds);
    setEpisodeOffset(nextPart ? nextPart.start - 1 : 0);

    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("episode", String(nextEpisode));
    currentUrl.searchParams.set("language", nextAudioLanguageRef.current);
    const seasonNumber = currentSeason.number ?? 1;
    currentUrl.searchParams.set("season", String(seasonNumber));
    currentUrl.searchParams.set(
      "episodeName",
      currentUrl.searchParams.has("media_type") ? `S${seasonNumber}E${nextEpisode}` : `E${nextEpisode}`,
    );
    if (nextPart) {
      currentUrl.searchParams.set(
        "source_episode",
        String(nextEpisode - nextPart.start + 1),
      );
    } else {
      currentUrl.searchParams.delete("source_episode");
    }
    for (const key of ["anilist_id", "mal_id", "anikoto_episode_id"]) {
      currentUrl.searchParams.delete(key);
    }
    appendMegaPlayParams(
      currentUrl.searchParams,
      nextPart?.ids || identityIds,
    );
    currentUrl.searchParams.delete("mochi_url");
    window.history.replaceState(null, "", currentUrl);
  }

interface AutoNextContext {
  episodeNumber: number;
  autoPlayNextEpisode: boolean;
  episodeCount: number;
  clearAutoNext: () => void;
  setAutoNext: Dispatch<StateUpdater<AutoNextState | null>>;
  autoNextTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  changeEpisode: (nextEpisode: number, autoplay?: boolean) => void;
  nextSeason: number | null;
  continueNextSeason: () => void;
}

export interface AutoNextState {
  episode: number;
  seconds: number;
  season?: number | undefined;
}

export function scheduleAutoNext({
  episodeNumber, autoPlayNextEpisode, episodeCount, clearAutoNext, setAutoNext,
  autoNextTimerRef, changeEpisode, nextSeason, continueNextSeason,
}: AutoNextContext) {
  const crossesSeason = episodeCount > 0 && episodeNumber >= episodeCount && nextSeason !== null;
  const nextEp = crossesSeason ? 1 : episodeNumber + 1;
  if (!autoPlayNextEpisode || episodeCount <= 0 || (!crossesSeason && nextEp > episodeCount)) {
    return;
  }

  clearAutoNext();
  let seconds = 10;
  const season = crossesSeason ? nextSeason : undefined;
  setAutoNext({ episode: nextEp, seconds, season });
  autoNextTimerRef.current = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearAutoNext();
      if (crossesSeason) continueNextSeason();
      else changeEpisode(nextEp, true);
    } else {
      setAutoNext({ episode: nextEp, seconds, season });
    }
  }, 1000);
}

interface AnimeSettingsContext {
  setAutoPlayNextEpisode: Dispatch<StateUpdater<boolean>>;
  setAutoSkipIntroOutro: Dispatch<StateUpdater<boolean>>;
  clearAutoNext: () => void;
  autoSkippedMarkerRef: MutableRef<string | null>;
}

export function watchAnimeSettings({
  setAutoPlayNextEpisode, setAutoSkipIntroOutro, clearAutoNext,
  autoSkippedMarkerRef,
}: AnimeSettingsContext) {
  const syncAnimeSettings = () => {
    const nextAutoPlay = readAnimeSetting("autoPlayNextEpisode");
    const nextAutoSkip = readAnimeSetting("autoSkipIntroOutro");
    setAutoPlayNextEpisode(nextAutoPlay);
    setAutoSkipIntroOutro(nextAutoSkip);
    if (!nextAutoPlay) clearAutoNext();
    if (!nextAutoSkip) autoSkippedMarkerRef.current = null;
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== null &&
      event.key !== ANIME_SETTING_KEYS.autoPlayNextEpisode &&
      event.key !== ANIME_SETTING_KEYS.autoSkipIntroOutro
    ) {
      return;
    }
    syncAnimeSettings();
  };
  const onAnimeSettingUpdated = () => syncAnimeSettings();
  window.addEventListener("storage", onStorage);
  document.addEventListener("animeSettingUpdated", onAnimeSettingUpdated);
  return () => {
    window.removeEventListener("storage", onStorage);
    document.removeEventListener(
      "animeSettingUpdated",
      onAnimeSettingUpdated,
    );
  };
}

interface EpisodeCountContext {
  playbackIds: Partial<Record<AnimeProvider, string>>;
  format: string;
  episodeParts: PlaybackEpisodePartRange[];
  setLoadingEpisodeCount: Dispatch<StateUpdater<boolean>>;
  setEpisodeCount: Dispatch<StateUpdater<number>>;
  episodeNumber: number;
}

export function loadEpisodeCount({
  playbackIds, format, episodeParts, setLoadingEpisodeCount, setEpisodeCount,
  episodeNumber,
}: EpisodeCountContext) {
  if (
    (!playbackIds.mal &&
      !playbackIds.anilist &&
      !playbackIds.anikotoEpisode) ||
    isAnimeMovieFormat(format) ||
    episodeParts.length > 1
  ) {
    setLoadingEpisodeCount(false);
    return;
  }
  let cancelled = false;
  setLoadingEpisodeCount(true);
  fetchAnimeEpisodeCount(playbackIds)
    .then((count) => {
      if (!cancelled && count > 0) {
        setEpisodeCount((currentCount) =>
          mergeEpisodeCount(currentCount, count, episodeNumber),
        );
      }
    })
    .finally(() => {
      if (!cancelled) setLoadingEpisodeCount(false);
    });
  return () => {
    cancelled = true;
  };
}
