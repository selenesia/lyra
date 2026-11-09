import Hls from "hls.js";
import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { cleanDuration, readPlayerStorage } from "./playerState.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import type {
  MediaState,
  MediaStateHints,
} from "../../core/media/mediaState.ts";

interface MediaEventsContext {
  videoRef: MutableRef<HTMLVideoElement | null>;
  mediaSessionRef: MutableRef<number>;
  sourceContextKey: string;
  sourceContextRef: MutableRef<string>;
  mediaStateRef: MutableRef<MediaState>;
  manifestDurationRef: MutableRef<number | null>;
  pendingSeekRef: MutableRef<number | null>;
  renderPlaybackTime: (value: number | null, preview?: boolean) => void;
  playIntentRef: MutableRef<boolean>;
  playAfterSeekRef: MutableRef<boolean>;
  hlsRef: MutableRef<Hls | null>;
  playRequestRef: MutableRef<number>;
  syncMediaState: (patch?: MediaStateHints) => void;
  rebufferStartedAtRef: MutableRef<number | null>;
  totalRebufferDurationMsRef: MutableRef<number>;
  rebufferCountRef: MutableRef<number>;
  setPlaybackStarted: Dispatch<StateUpdater<boolean>>;
  firstFrameRecordedRef: MutableRef<boolean>;
  resetTimer: () => void;
  sessionStartedAtRef: MutableRef<number>;
  notify4kFallback: () => void;
  autoNextTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  startAutoNextRef: MutableRef<() => void>;
  setPreloadSource: Dispatch<StateUpdater<string>>;
  videoSrc: string;
  setConfirmedEpisodeNumber: Dispatch<StateUpdater<number | null>>;
  episodeNumber: number;
  retryCountRef: MutableRef<number>;
  nativeRetryTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  fallbackFrom4k: () => boolean;
  resumeAppliedRef: MutableRef<boolean>;
  resumeKey: string;
  initialEpisode: number;
  language: string;
  initialLanguage: string;
  params: URLSearchParams;
  persistProgress: (currentTime: number, duration: number, completed?: boolean) => void;
}

export function attachMediaEvents({
  videoRef, mediaSessionRef, sourceContextKey, sourceContextRef, mediaStateRef,
  manifestDurationRef, pendingSeekRef, renderPlaybackTime, playIntentRef,
  playAfterSeekRef, hlsRef, playRequestRef, syncMediaState,
  rebufferStartedAtRef, totalRebufferDurationMsRef, rebufferCountRef,
  setPlaybackStarted, firstFrameRecordedRef, resetTimer, sessionStartedAtRef,
  notify4kFallback, autoNextTimerRef, startAutoNextRef, setPreloadSource,
  videoSrc, setConfirmedEpisodeNumber, episodeNumber, retryCountRef,
  nativeRetryTimerRef, fallbackFrom4k, resumeAppliedRef, resumeKey,
  initialEpisode, language, initialLanguage, params, persistProgress,
}: MediaEventsContext) {
  const video = videoRef.current;
  if (!video) return;
  const mediaSession = ++mediaSessionRef.current;
  const context = sourceContextKey;
  let lastKnownTime = 0;
  let lastKnownDuration = 0;
  let completed = false;
  let lastSavedAt = 0;
  const isCurrentMedia = () =>
    mediaSession === mediaSessionRef.current &&
    videoRef.current === video &&
    context === sourceContextRef.current;

  const boundedTime = (seconds: number) => {
    const durationLimit =
      mediaStateRef.current.duration ||
      manifestDurationRef.current ||
      cleanDuration(video.duration);
    return durationLimit > 0
      ? Math.max(0, Math.min(durationLimit, seconds))
      : Math.max(0, seconds);
  };
  const effectiveTime = () => video.currentTime;
  const restorePendingSeek = () => {
    const pending = pendingSeekRef.current;
    if (pending === null || video.readyState === 0) return;
    const target = boundedTime(pending);
    if (Math.abs(video.currentTime - target) > 0.01) {
      try {
        video.currentTime = target;
      } catch {}
      renderPlaybackTime(effectiveTime());
    }
  };
  const clearSettledPendingSeek = () => {
    const pending = pendingSeekRef.current;
    if (
      pending !== null &&
      !video.seeking &&
      Math.abs(effectiveTime() - pending) < 0.25
    ) {
      pendingSeekRef.current = null;
    }
  };
  const resumePlaybackIfWanted = () => {
    if (!playIntentRef.current && !playAfterSeekRef.current) return;
    hlsRef.current?.resumeBuffering();
    const requestId = ++playRequestRef.current;
    video
      .play()
      .then(() => {
        if (requestId !== playRequestRef.current || !isCurrentMedia()) return;
        playAfterSeekRef.current = false;
      })
      .catch((error) => {
        if (requestId !== playRequestRef.current || !isCurrentMedia()) return;
        playIntentRef.current = false;
        playAfterSeekRef.current = false;
        hlsRef.current?.pauseBuffering();
        recordStreamDiagnostic(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "autoplay_blocked"
            : "playback_rejected",
        );
      });
  };

  const syncPlaybackState = () => {
    if (isCurrentMedia()) syncMediaState();
  };
  const finishRebuffer = () => {
    if (rebufferStartedAtRef.current === null) return;
    const durationMs = Math.round(
      performance.now() - rebufferStartedAtRef.current,
    );
    totalRebufferDurationMsRef.current += durationMs;
    recordStreamDiagnostic("buffering_end", {
      durationMs,
      rebufferCount: rebufferCountRef.current,
      totalRebufferDurationMs: totalRebufferDurationMsRef.current,
    });
    rebufferStartedAtRef.current = null;
  };

  const handlePlay = () => {
    if (!isCurrentMedia()) return;
    playIntentRef.current = true;
    syncPlaybackState();
  };
  const handlePlaying = () => {
    if (!isCurrentMedia()) return;
    playIntentRef.current = true;
    syncMediaState({
      sourceReady: true,
      buffering: false,
      bufferingReason: null,
      error: null,
    });
    setPlaybackStarted(true);
    if (!firstFrameRecordedRef.current) {
      firstFrameRecordedRef.current = true;
      resetTimer();
      recordStreamDiagnostic("first_playable_frame", {
        elapsedMs: Math.round(
          performance.now() - sessionStartedAtRef.current,
        ),
      });
    }
    finishRebuffer();
    notify4kFallback();
  };
  const handlePause = () => {
    if (!isCurrentMedia()) return;
    if (video.readyState > 0 && !video.ended) {
      playRequestRef.current += 1;
      playIntentRef.current = false;
      playAfterSeekRef.current = false;
    }
    syncMediaState({ buffering: false, bufferingReason: null });
    finishRebuffer();
    if (!playIntentRef.current) hlsRef.current?.pauseBuffering();
    saveResume();
  };
  const handleEnded = () => {
    if (!isCurrentMedia()) return;
    playIntentRef.current = false;
    playAfterSeekRef.current = false;
    renderPlaybackTime(effectiveTime());
    syncMediaState({
      sourceReady: true,
      buffering: false,
      bufferingReason: null,
    });
    finishRebuffer();
    saveResume();
    if (autoNextTimerRef.current === null) startAutoNextRef.current();
  };
  const handleTimeUpdate = () => {
    if (!isCurrentMedia()) return;
    lastKnownTime = effectiveTime();
    renderPlaybackTime(lastKnownTime);
    clearSettledPendingSeek();
    syncMediaState(
      !video.paused && !video.seeking
        ? { buffering: false, bufferingReason: null }
        : {},
    );
    if (Date.now() - lastSavedAt >= 15_000) saveResume();
    const remaining = video.duration - video.currentTime;
    if (remaining > 60 || remaining <= 0) setPreloadSource("");
    if (!video.paused && !video.seeking && remaining > 0 && remaining <= 60) {
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= video.currentTime &&
            video.buffered.end(index) - video.currentTime >= Math.min(10, remaining)) {
          setPreloadSource(videoSrc);
          break;
        }
      }
    }
  };
  const handleMetadata = () => {
    if (!isCurrentMedia()) return;
    setConfirmedEpisodeNumber(episodeNumber > 0 ? episodeNumber : null);
    syncMediaState({ sourceReady: true });
    renderPlaybackTime(effectiveTime());
  };
  const handleDurationChange = () => {
    if (isCurrentMedia()) syncMediaState();
  };
  const handleBuffering = (reason: "waiting" | "stalled") => {
    if (!isCurrentMedia()) return;
    if (
      reason === "stalled" &&
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    )
      return;
    syncMediaState({ buffering: true, bufferingReason: reason });
    if (
      firstFrameRecordedRef.current &&
      rebufferStartedAtRef.current === null
    ) {
      rebufferStartedAtRef.current = performance.now();
      rebufferCountRef.current += 1;
      recordStreamDiagnostic("buffering_start", {
        playbackTime: Math.round(effectiveTime() * 1000) / 1000,
        reason,
        rebufferCount: rebufferCountRef.current,
      });
    }
  };
  const handleWaiting = () => handleBuffering("waiting");
  const handleStalled = () => handleBuffering("stalled");
  const handlePlayable = () => {
    if (!isCurrentMedia()) return;
    const hasFutureData =
      !video.paused &&
      !video.seeking &&
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    syncMediaState({
      sourceReady: true,
      ...(hasFutureData ? { buffering: false, bufferingReason: null } : {}),
    });
    restorePendingSeek();
    resumePlaybackIfWanted();
    syncPlaybackState();
  };
  const handleError = () => {
    if (!isCurrentMedia()) return;
    const mediaError = video.error;
    const code = mediaError ? mediaError.code : 0;
    recordStreamDiagnostic("media_error", { code });
    if (hlsRef.current) return;
    if (
      (code === 2 || code === 3 || code === 4) &&
      retryCountRef.current < 1 &&
      videoSrc
    ) {
      syncMediaState({ error: null, buffering: true });
      const retryTime = boundedTime(
        pendingSeekRef.current ?? effectiveTime(),
      );
      if (retryTime > 0) pendingSeekRef.current = retryTime;
      retryCountRef.current++;
      nativeRetryTimerRef.current = setTimeout(() => {
        nativeRetryTimerRef.current = null;
        if (!isCurrentMedia()) return;
        syncMediaState({ error: null, buffering: true });
        if (video) {
          video.load();
          if (playIntentRef.current || playAfterSeekRef.current) {
            video.play().catch(() => {});
          }
        }
      }, 2000);
      return;
    }
    if (fallbackFrom4k()) return;
    syncMediaState({
      error: negativeMessage("playback was interrupted; please try again"),
      buffering: false,
      bufferingReason: null,
    });
  };

  const handleProgress = () => {
    if (isCurrentMedia()) syncMediaState();
  };
  const handleVolumeChange = () => {
    if (isCurrentMedia()) syncMediaState();
  };
  const restoreResumePosition = () => {
    if (!isCurrentMedia()) return;
    if (pendingSeekRef.current !== null) {
      restorePendingSeek();
      return;
    }
    if (resumeAppliedRef.current) return;
    resumeAppliedRef.current = true;
    const savedResume = readPlayerStorage(resumeKey);
    const requestedTime =
      episodeNumber === initialEpisode && language === initialLanguage
        ? Number(params.get("resume"))
        : 0;
    if (savedResume || requestedTime > 0) {
      try {
        const savedTime =
          requestedTime > 0
            ? requestedTime
            : Number(JSON.parse(savedResume || "null")?.currentTime);
        const durationLimit =
          mediaStateRef.current.duration ||
          manifestDurationRef.current ||
          cleanDuration(video.duration) ||
          Infinity;
        if (
          Number.isFinite(savedTime) &&
          savedTime > 0 &&
          savedTime < durationLimit * (requestedTime > 0 ? 1 : 0.9)
        ) {
          try {
            video.currentTime = savedTime;
            if (requestedTime > 0) {
              params.delete("resume");
              const currentUrl = new URL(window.location.href);
              currentUrl.searchParams.delete("resume");
              window.history.replaceState(null, "", currentUrl);
            }
          } catch {}
        }
      } catch {}
    }
  };

  const events: [string, EventListener][] = [
    ["play", handlePlay],
    ["playing", handlePlaying],
    ["pause", handlePause],
    ["ended", handleEnded],
    ["timeupdate", handleTimeUpdate],
    ["loadedmetadata", handleMetadata],
    ["loadedmetadata", restoreResumePosition],
    ["durationchange", handleDurationChange],
    ["waiting", handleWaiting],
    ["loadeddata", handlePlayable],
    ["canplay", handlePlayable],
    ["canplaythrough", handlePlayable],
    ["error", handleError],
    ["stalled", handleStalled],
    ["progress", handleProgress],
    ["volumechange", handleVolumeChange],
    [
      "seeking",
      () => {
        if (!isCurrentMedia()) return;
        renderPlaybackTime(effectiveTime());
        syncPlaybackState();
      },
    ],
    [
      "seeked",
      () => {
        if (!isCurrentMedia()) return;
        clearSettledPendingSeek();
        if (video.paused && !playIntentRef.current)
          hlsRef.current?.pauseBuffering();
        const needsBuffering =
          !video.paused &&
          !video.ended &&
          video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
        syncMediaState({
          buffering: needsBuffering,
          bufferingReason: needsBuffering ? "seeking" : null,
        });
        saveResume();
      },
    ],
    ["ratechange", syncPlaybackState],
    ["resize", syncPlaybackState],
  ];
  for (const [eventName, listener] of events) {
    video.addEventListener(eventName, listener);
  }
  const saveResume = () => {
    if (!isCurrentMedia() || video.currentTime <= 0) return;
    lastKnownTime = video.currentTime;
    lastKnownDuration =
      mediaStateRef.current.duration || cleanDuration(video.duration);
    completed = video.ended;
    lastSavedAt = Date.now();
    persistProgress(lastKnownTime, lastKnownDuration, completed);
  };
  const syncOnVisibility = () => {
    syncPlaybackState();
    if (document.hidden) saveResume();
  };
  window.addEventListener("pagehide", saveResume);
  document.addEventListener("visibilitychange", syncOnVisibility);
  window.addEventListener("focus", syncOnVisibility);

  syncPlaybackState();

  return () => {
    if (mediaSessionRef.current === mediaSession)
      mediaSessionRef.current += 1;
    finishRebuffer();
    recordStreamDiagnostic("playback_qoe", {
      rebufferCount: rebufferCountRef.current,
      totalRebufferDurationMs: totalRebufferDurationMsRef.current,
    });
    const currentTime = lastKnownTime;
    if (currentTime > 0) {
      persistProgress(currentTime, lastKnownDuration, completed);
    }
    for (const [eventName, listener] of events) {
      video.removeEventListener(eventName, listener);
    }
    document.removeEventListener("visibilitychange", syncOnVisibility);
    window.removeEventListener("focus", syncOnVisibility);
    window.removeEventListener("pagehide", saveResume);
    if (nativeRetryTimerRef.current) {
      clearTimeout(nativeRetryTimerRef.current);
      nativeRetryTimerRef.current = null;
    }
  };
}
