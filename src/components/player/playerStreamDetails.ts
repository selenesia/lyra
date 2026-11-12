import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { type SubtitleTrack, externalSubtitleTracks } from "./tracks.ts";
import { type StreamInfoResponse, fetchStreamInfo } from "./streamInfo.ts";
import { type SkipRange, readPlayerStorage } from "./playerState.ts";
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
  streamQuery: URLSearchParams | null;
  titleMode: boolean;
  setStreamLanguages: Dispatch<StateUpdater<string[]>>;
  setSourceLanguage: Dispatch<StateUpdater<string>>;
  setLoadingStreamInfo: Dispatch<StateUpdater<boolean>>;
  sourceGenerationRef: MutableRef<number>;
  sourceContextRef: MutableRef<string>;
  manifestDurationRef: MutableRef<number | null>;
  setIntroMarker: Dispatch<StateUpdater<SkipRange | null>>;
  setOutroMarker: Dispatch<StateUpdater<SkipRange | null>>;
  language: string;
  languageStreamInfoRef: MutableRef<{ params: string; info: StreamInfoResponse } | null>;
  syncMediaState: (patch?: MediaStateHints) => void;
  setStreamProvider: Dispatch<StateUpdater<string | null>>;
  setStreamProviders: Dispatch<StateUpdater<string[]>>;
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

export function streamProviderIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^[a-z0-9-]{1,32}$/.test(id)))]
    : [];
}

export function loadStreamDetails({
  streamQuery, titleMode, setStreamLanguages, setSourceLanguage,
  setLoadingStreamInfo, sourceGenerationRef, sourceContextRef,
  manifestDurationRef, setIntroMarker, setOutroMarker, language,
  languageStreamInfoRef, syncMediaState, setStreamProvider, setStreamProviders,
  fallbackPendingRef, requested4kContext, playbackContext, request4k, notify4kFallback,
  setSubtitleTracks, notifyPreference, mediaStateRef, unavailableMessage,
}: StreamDetailsContext) {
  if (!streamQuery) {
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
  const params = streamQuery;

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
      setStreamProviders(streamProviderIds(info.providers));
      fallbackPendingRef.current = requested4kContext === playbackContext &&
        (info.quality_fallback === true || (!request4k &&
          !info.qualities?.some((quality) => Number(quality.height) >= 2160)));
      notify4kFallback();
      const tracks = externalSubtitleTracks(info?.tracks);
      setSubtitleTracks(tracks);
      if (titleMode) {
        const languages = Array.isArray(info.languages)
          ? info.languages.filter((code): code is string => typeof code === "string" && /^[a-z]{2,3}$/.test(code))
          : [];
        const sourceLanguage = typeof info.source?.language === "string" ? info.source.language : "";
        setStreamLanguages(languages);
        setSourceLanguage(sourceLanguage);
        if (sourceLanguage && sourceLanguage !== "und" && sourceLanguage !== language) {
          notifyPreference("audio", "selected audio is unavailable for this title");
        }
      } else if (
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
