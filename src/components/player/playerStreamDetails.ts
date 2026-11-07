import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { type SubtitleTrack, externalSubtitleTracks } from "./tracks.ts";
import { type StreamInfoResponse, fetchStreamInfo } from "./streamInfo.ts";
import { type SkipRange, readPlayerStorage } from "./playerState.ts";
import {
  type AnimeProvider,
  hasMegaPlayIdentifier,
  appendMegaPlayParams,
} from "../../features/anime/animeIdentity.ts";
import { RequestError, negativeMessage } from "../../core/runtime/messages.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import type {
  MediaStateHints,
  MediaState,
} from "../../core/media/mediaState.ts";
import {
  ANIME_LANGUAGE_KEY,
  readAnimeLanguage,
} from "../../core/media/animeSettings.ts";

interface StreamDetailsContext {
  episodeNumber: number;
  playbackIds: Partial<Record<AnimeProvider, string>>;
  setLoadingStreamInfo: Dispatch<StateUpdater<boolean>>;
  sourceGenerationRef: MutableRef<number>;
  sourceContextRef: MutableRef<string>;
  manifestDurationRef: MutableRef<number | null>;
  setIntroMarker: Dispatch<StateUpdater<SkipRange | null>>;
  setOutroMarker: Dispatch<StateUpdater<SkipRange | null>>;
  sourceEpisodeNumber: number;
  language: "sub" | "dub";
  streamSessionRef: MutableRef<string>;
  qualityRequest: "" | "2160p" | "auto";
  languageStreamInfoRef: MutableRef<{ params: string; info: StreamInfoResponse } | null>;
  syncMediaState: (patch?: MediaStateHints) => void;
  setStreamProvider: Dispatch<StateUpdater<string | null>>;
  fallbackPendingRef: MutableRef<boolean>;
  requested4kContext: string;
  playbackContext: string;
  request4k: boolean;
  notify4kFallback: () => void;
  setSubtitleTracks: Dispatch<StateUpdater<SubtitleTrack[]>>;
  notifyPreference: (key: string, message: string) => void;
  mediaStateRef: MutableRef<MediaState>;
  unavailableMessage: (status?: number | undefined) => string;
}

export function loadStreamDetails({
  episodeNumber, playbackIds, setLoadingStreamInfo, sourceGenerationRef,
  sourceContextRef, manifestDurationRef, setIntroMarker, setOutroMarker,
  sourceEpisodeNumber, language, streamSessionRef, qualityRequest,
  languageStreamInfoRef, syncMediaState, setStreamProvider, fallbackPendingRef,
  requested4kContext, playbackContext, request4k, notify4kFallback,
  setSubtitleTracks, notifyPreference, mediaStateRef, unavailableMessage,
}: StreamDetailsContext) {
  if (
    !(episodeNumber > 0 || playbackIds.anikotoEpisode) ||
    !hasMegaPlayIdentifier(playbackIds)
  ) {
    setLoadingStreamInfo(false);
    return;
  }
  const controller = new AbortController();
  const requestGeneration = ++sourceGenerationRef.current;
  const requestContext = sourceContextRef.current;
  setLoadingStreamInfo(true);
  const startedAt = performance.now();
  manifestDurationRef.current = null;
  setIntroMarker(null);
  setOutroMarker(null);
  const params = new URLSearchParams({
    episode: String(sourceEpisodeNumber),
    language,
    session: streamSessionRef.current,
  });
  if (qualityRequest) params.set("preferred_quality", qualityRequest);
  appendMegaPlayParams(params, playbackIds);

  const confirmed = languageStreamInfoRef.current;
  languageStreamInfoRef.current = null;
  const streamInfo =
    confirmed?.params === params.toString()
      ? Promise.resolve(confirmed.info)
      : fetchStreamInfo(params, controller.signal);
  streamInfo
    .then((info) => {
      if (
        controller.signal.aborted ||
        requestGeneration !== sourceGenerationRef.current ||
        requestContext !== sourceContextRef.current
      ) {
        return;
      }
      recordStreamDiagnostic("stream_info_ready", {
        elapsedMs: Math.round(performance.now() - startedAt),
        tracks: Array.isArray(info?.tracks) ? info.tracks.length : 0,
      });
      const nextDuration = Number(info?.duration || 0);
      if (Number.isFinite(nextDuration) && nextDuration > 0) {
        manifestDurationRef.current = nextDuration;
        syncMediaState({ durationHint: nextDuration });
      }
      setIntroMarker(info?.intro || null);
      setOutroMarker(info?.outro || null);
      setStreamProvider(info.source?.provider || "");
      fallbackPendingRef.current = requested4kContext === playbackContext &&
        (info.quality_fallback === true || (!request4k &&
          !info.qualities?.some((quality) => Number(quality.height) >= 2160)));
      notify4kFallback();
      const tracks = externalSubtitleTracks(info?.tracks);
      setSubtitleTracks(tracks);
      if (
        readPlayerStorage(ANIME_LANGUAGE_KEY) &&
        language === readAnimeLanguage() &&
        info.source?.language !== language
      ) {
        notifyPreference("audio", "selected audio is unconfirmed");
      }
    })
    .catch((err) => {
      if (
        controller.signal.aborted ||
        requestGeneration !== sourceGenerationRef.current ||
        requestContext !== sourceContextRef.current
      ) {
        return;
      }
      recordStreamDiagnostic("stream_info_error", {
        elapsedMs: Math.round(performance.now() - startedAt),
        code: err instanceof RequestError ? err.code : "STREAM_INFO_UNKNOWN",
        status: err instanceof RequestError ? err.status : undefined,
        message: negativeMessage("stream information request failed"),
      });
      if (!mediaStateRef.current.sourceReady && err instanceof RequestError && err.status === 404) {
        syncMediaState({ error: unavailableMessage(404), buffering: false });
      }
    })
    .finally(() => {
      if (
        !controller.signal.aborted &&
        requestGeneration === sourceGenerationRef.current &&
        requestContext === sourceContextRef.current
      ) {
        setLoadingStreamInfo(false);
      }
    });

  return () => {
    controller.abort();
  };
}
