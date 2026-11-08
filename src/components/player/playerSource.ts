import Hls from "hls.js";
import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import {
  type SubtitleTrack,
  type AudioTrack,
  selectTrack,
  applySubtitleTrack,
} from "./tracks.ts";
import { type StreamQualityOption, hlsLoadPolicy } from "./streamInfo.ts";
import { createSourceRecovery } from "./sourceRecovery.ts";
import { type PlayerSelector, qualityLabel } from "./playerState.ts";
import { attachPlaybackTracks } from "./playbackTracks.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import type { MediaStateHints } from "../../core/media/mediaState.ts";
import {
  PLAYER_SIZE_ABR_CONFIG,
  preferredQualityLevel,
  applyQualitySelection,
} from "../../core/media/hlsQuality.ts";
import { readAnimeQuality } from "../../core/media/animeSettings.ts";

interface PlayerSourceContext {
  videoRef: MutableRef<HTMLVideoElement | null>;
  videoSrc: string;
  hlsSessionRef: MutableRef<number>;
  tracksSourceRef: MutableRef<string>;
  sourceContextKey: string;
  sessionStartedAtRef: MutableRef<number>;
  firstSegmentRecordedRef: MutableRef<boolean>;
  firstFrameRecordedRef: MutableRef<boolean>;
  rebufferStartedAtRef: MutableRef<number | null>;
  rebufferCountRef: MutableRef<number>;
  totalRebufferDurationMsRef: MutableRef<number>;
  episodeNumber: number;
  language: string;
  trackVersion: "sub" | "dub";
  titleMode: boolean;
  manifestDurationRef: MutableRef<number | null>;
  syncMediaState: (patch?: MediaStateHints) => void;
  setQualityOptions: Dispatch<StateUpdater<StreamQualityOption[]>>;
  setSelectedQuality: Dispatch<StateUpdater<number>>;
  setActiveQuality: Dispatch<StateUpdater<number>>;
  setAutoQuality: Dispatch<StateUpdater<number>>;
  setAudioTracksReady: Dispatch<StateUpdater<boolean>>;
  setEmbeddedSubtitles: Dispatch<StateUpdater<SubtitleTrack[]>>;
  playIntentRef: MutableRef<boolean>;
  playAfterSeekRef: MutableRef<boolean>;
  setAudioTracks: Dispatch<StateUpdater<AudioTrack[]>>;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  setActiveAudioTrack: Dispatch<StateUpdater<number>>;
  audioPreferenceRef: MutableRef<string>;
  audioChoiceRef: MutableRef<{ source: string; id: string }>;
  prefer4k: boolean;
  request4k: boolean;
  start4k: boolean;
  hlsRef: MutableRef<Hls | null>;
  sourceContextRef: MutableRef<string>;
  pendingSeekRef: MutableRef<number | null>;
  fallbackPendingRef: MutableRef<boolean>;
  setInfoRevision: Dispatch<StateUpdater<number>>;
  fallbackFrom4k: () => boolean;
  unavailableMessage: (status?: number | undefined) => string;
}

export function attachPlayerSource({
  videoRef, videoSrc, hlsSessionRef, tracksSourceRef, sourceContextKey,
  sessionStartedAtRef, firstSegmentRecordedRef, firstFrameRecordedRef,
  rebufferStartedAtRef, rebufferCountRef, totalRebufferDurationMsRef,
  episodeNumber, language, trackVersion, titleMode, manifestDurationRef, syncMediaState,
  setQualityOptions, setSelectedQuality, setActiveQuality, setAutoQuality,
  setAudioTracksReady, setEmbeddedSubtitles, playIntentRef, playAfterSeekRef,
  setAudioTracks, setOpenSelector, setActiveAudioTrack, audioPreferenceRef,
  audioChoiceRef, prefer4k, request4k, start4k, hlsRef, sourceContextRef,
  pendingSeekRef, fallbackPendingRef, setInfoRevision, fallbackFrom4k,
  unavailableMessage,
}: PlayerSourceContext) {
  const video = videoRef.current;
  if (!video || !videoSrc) return;
  const hlsSession = ++hlsSessionRef.current;
  tracksSourceRef.current = videoSrc;
  const sourceContext = sourceContextKey;
  sessionStartedAtRef.current = performance.now();
  firstSegmentRecordedRef.current = false;
  firstFrameRecordedRef.current = false;
  rebufferStartedAtRef.current = null;
  rebufferCountRef.current = 0;
  totalRebufferDurationMsRef.current = 0;
  recordStreamDiagnostic("playback_start", {
    episode: episodeNumber,
    language,
  });
  manifestDurationRef.current = null;
  syncMediaState({
    error: null,
    buffering: true,
    sourceReady: false,
    bufferingReason: "waiting",
    durationHint: null,
    logicalOffset: 0,
  });
  setQualityOptions([]);
  setSelectedQuality(-1);
  setActiveQuality(-1);
  setAutoQuality(-1);
  setAudioTracksReady(false);
  setEmbeddedSubtitles([]);
  if (playIntentRef.current) {
    playAfterSeekRef.current = true;
  }
  const trackCallbacks = {
    onSubtitles: setEmbeddedSubtitles,
    onAudio: (tracks: AudioTrack[]) => {
      setAudioTracks(tracks);
      setAudioTracksReady(true);
    },
    onAudioLoading: () => {
      setAudioTracksReady(false);
      setOpenSelector((current) => (current === "audio" ? null : current));
    },
    onActiveAudio: setActiveAudioTrack,
    selectAudio: (tracks: AudioTrack[]) =>
      selectTrack(
        tracks,
        audioPreferenceRef.current,
        "audio",
        trackVersion,
        audioChoiceRef.current.source === videoSrc
          ? audioChoiceRef.current.id
          : undefined,
      ),
  };
  if (Hls.isSupported()) {
    let networkRecoveries = 0;
    let mediaRecoveries = 0;
    let recoveryTimer: number | null = null;
    const hls = new Hls({
      enableWorker: true,
      startFragPrefetch: true,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: (prefer4k || request4k || start4k ? 64 : 24) * 1024 * 1024,
      ...PLAYER_SIZE_ABR_CONFIG,
      capLevelToPlayerSize: !titleMode,
      manifestLoadPolicy: hlsLoadPolicy(23_000, 25_000, 1, 1),
      playlistLoadPolicy: hlsLoadPolicy(8_000, 15_000, 2, 2),
      fragLoadPolicy: hlsLoadPolicy(10_000, 45_000, 2, 3),
      keyLoadPolicy: hlsLoadPolicy(8_000, 20_000, 2, 2),
    });
    hlsRef.current = hls;
    const isCurrentHls = () =>
      hlsSession === hlsSessionRef.current &&
      hlsRef.current === hls &&
      sourceContext === sourceContextRef.current;
    const sourceRecovery = createSourceRecovery(
      () => {
        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
        recoveryTimer = null;
        pendingSeekRef.current ??= video.currentTime;
        hls.stopLoad();
      },
      () => {
        if (!isCurrentHls()) return;
        fallbackPendingRef.current = false;
        hls.loadSource(videoSrc);
        setInfoRevision((revision) => revision + 1);
      },
    );
    const onPlaybackProgress = () => sourceRecovery.progress(video.currentTime);
    video.addEventListener("timeupdate", onPlaybackProgress);
    const detachTracks = attachPlaybackTracks({
      video,
      hls,
      isCurrent: isCurrentHls,
      ...trackCallbacks,
    });
    hls.subtitleDisplay = false;
    hls.subtitleTrack = -1;
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (isCurrentHls()) hls.loadSource(videoSrc);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, manifest) => {
      if (!isCurrentHls()) return;
      networkRecoveries = 0;
      syncMediaState({ sourceReady: true, error: null });
      const levels = manifest.levels
        .map((level, index) => {
          const width = Number(level.width || 0);
          const height = Number(level.height || 0);
          const bitrate = Number(level.bitrate || 0);
          return {
            index,
            width,
            height,
            bitrate,
            label: qualityLabel(height, bitrate),
          } satisfies StreamQualityOption;
        })
        .sort(
          (left, right) =>
            right.height - left.height || right.bitrate - left.bitrate,
        );
      setQualityOptions(levels);
      const preferredLevel = preferredQualityLevel(
        request4k ? "2160p" : readAnimeQuality(),
        levels,
      );
      applyQualitySelection(
        hls,
        preferredLevel,
        levels.map((level) => level.index),
      );
      setSelectedQuality(preferredLevel);
      setActiveQuality(-1);
      if (preferredLevel < 0) {
        const nextAutoLevel = Number(hls.nextAutoLevel);
        setAutoQuality(
          levels.some((level) => level.index === nextAutoLevel)
            ? nextAutoLevel
            : -1,
        );
      } else {
        setAutoQuality(-1);
      }
      recordStreamDiagnostic("manifest_ready", {
        elapsedMs: Math.round(
          performance.now() - sessionStartedAtRef.current,
        ),
        levels: manifest.levels.length,
      });
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_event, levelInfo) => {
      if (!isCurrentHls()) return;
      const nextDuration = Number(levelInfo.details.totalduration || 0);
      if (
        levelInfo.details.live === false &&
        Number.isFinite(nextDuration) &&
        nextDuration > 0 &&
        manifestDurationRef.current === null
      ) {
        manifestDurationRef.current = nextDuration;
        syncMediaState({ durationHint: nextDuration, sourceReady: true });
      }
    });
    hls.on(Hls.Events.LEVEL_SWITCHING, (_event, levelInfo) => {
      if (!isCurrentHls() || !hls.autoLevelEnabled) return;
      const level = Number(levelInfo.level);
      setAutoQuality(Number.isInteger(level) && level >= 0 ? level : -1);
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, levelInfo) => {
      if (!isCurrentHls()) return;
      const level = Number(levelInfo.level);
      setActiveQuality(Number.isInteger(level) && level >= 0 ? level : -1);
      syncMediaState({ sourceReady: true });
    });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, trackInfo) => {
      if (!isCurrentHls()) return;
      const track = Number(trackInfo.id);
      setActiveAudioTrack(Number.isInteger(track) && track >= 0 ? track : -1);
      syncMediaState({ sourceReady: true });
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, fragmentInfo) => {
      if (!isCurrentHls()) return;
      networkRecoveries = 0;
      if (firstSegmentRecordedRef.current) return;
      firstSegmentRecordedRef.current = true;
      const stats = fragmentInfo.frag.stats;
      const loading = stats.loading;
      recordStreamDiagnostic("first_segment", {
        elapsedMs: Math.round(
          performance.now() - sessionStartedAtRef.current,
        ),
        bytes: stats.loaded,
        ttfbMs: Math.round(loading.first - loading.start),
        downloadMs: Math.round(loading.end - loading.first),
        retries: stats.retry,
      });
    });
    hls.on(Hls.Events.ERROR, (_event, hlsError) => {
      if (!isCurrentHls()) return;
      recordStreamDiagnostic("hls_error", {
        type: hlsError.type,
        detail: hlsError.details,
        status: hlsError.response?.code ?? null,
        fatal: hlsError.fatal,
      });
      if (sourceRecovery.recover(hlsError)) return;
      if (!hlsError.fatal) return;
      if (
        hlsError.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
        hlsError.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
      ) {
        if (fallbackFrom4k()) return;
        syncMediaState({
          error: unavailableMessage(hlsError.response?.code),
          buffering: false,
        });
        return;
      }
      if (hlsError.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (networkRecoveries < 1 && recoveryTimer === null) {
          const delay = 500 * 2 ** networkRecoveries;
          networkRecoveries += 1;
          recoveryTimer = window.setTimeout(() => {
            recoveryTimer = null;
            if (isCurrentHls()) hls.startLoad(video.currentTime);
          }, delay);
          return;
        }
      }
      if (
        hlsError.type === Hls.ErrorTypes.MEDIA_ERROR &&
        mediaRecoveries < 1
      ) {
        mediaRecoveries += 1;
        hls.recoverMediaError();
        return;
      }
      if (fallbackFrom4k()) return;
      syncMediaState({
        error: negativeMessage("playback was interrupted; please try again"),
        buffering: false,
      });
    });
    hls.attachMedia(video);
    return () => {
      sourceRecovery.dispose();
      video.removeEventListener("timeupdate", onPlaybackProgress);
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      if (hlsSessionRef.current === hlsSession) hlsSessionRef.current += 1;
      detachTracks();
      hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    const detachTracks = attachPlaybackTracks({
      video,
      isCurrent: () =>
        hlsSession === hlsSessionRef.current &&
        sourceContext === sourceContextRef.current,
      ...trackCallbacks,
    });
    video.src = videoSrc;
    video.load();
    return () => {
      if (hlsSessionRef.current === hlsSession) hlsSessionRef.current += 1;
      detachTracks();
      video.removeAttribute("src");
      video.load();
    };
  }
  syncMediaState({
    error: negativeMessage("hls playback is not supported in this browser"),
    buffering: false,
  });
}

interface SourceResetContext {
  clearAutoNext: () => void;
  setAvailable4kSource: Dispatch<StateUpdater<string>>;
  preferenceNoticesRef: MutableRef<Set<string>>;
  fallbackPendingRef: MutableRef<boolean>;
  subtitleRetryRef: MutableRef<boolean>;
  failedSubtitleIdsRef: MutableRef<Set<string>>;
  setFailedSubtitleIds: Dispatch<StateUpdater<string[]>>;
  setLoadedSubtitle: Dispatch<StateUpdater<{ source: string; id: string; url: string } | null>>;
  setSubtitleTracks: Dispatch<StateUpdater<SubtitleTrack[]>>;
  setEmbeddedSubtitles: Dispatch<StateUpdater<SubtitleTrack[]>>;
  setActiveSubtitle: Dispatch<StateUpdater<number>>;
  setAudioTracksReady: Dispatch<StateUpdater<boolean>>;
  videoRef: MutableRef<HTMLVideoElement | null>;
  hlsRef: MutableRef<Hls | null>;
  setConfirmedEpisodeNumber: Dispatch<StateUpdater<number | null>>;
  setPlaybackStarted: Dispatch<StateUpdater<boolean>>;
  manifestDurationRef: MutableRef<number | null>;
  sourceContextGenerationRef: MutableRef<number>;
  sourceSwitchTimeRef: MutableRef<number | null>;
  pendingSeekRef: MutableRef<number | null>;
  resumeAppliedRef: MutableRef<boolean>;
  retryCountRef: MutableRef<number>;
  playRequestRef: MutableRef<number>;
  playAfterSeekRef: MutableRef<boolean>;
  playIntentRef: MutableRef<boolean>;
  mediaHintsRef: MutableRef<MediaStateHints>;
  baseVideoSrc: string;
  renderPlaybackTime: (value: number | null, preview?: boolean) => void;
  syncMediaState: (patch?: MediaStateHints) => void;
}

export function resetSourceState({
  clearAutoNext, setAvailable4kSource, preferenceNoticesRef, fallbackPendingRef,
  subtitleRetryRef, failedSubtitleIdsRef, setFailedSubtitleIds,
  setLoadedSubtitle, setSubtitleTracks, setEmbeddedSubtitles, setActiveSubtitle,
  setAudioTracksReady, videoRef, hlsRef, setConfirmedEpisodeNumber,
  setPlaybackStarted, manifestDurationRef, sourceContextGenerationRef,
  sourceSwitchTimeRef, pendingSeekRef, resumeAppliedRef, retryCountRef,
  playRequestRef, playAfterSeekRef, playIntentRef, mediaHintsRef, baseVideoSrc,
  renderPlaybackTime, syncMediaState,
}: SourceResetContext) {
  clearAutoNext();
  setAvailable4kSource("");
  preferenceNoticesRef.current.clear();
  fallbackPendingRef.current = false;
  subtitleRetryRef.current = false;
  failedSubtitleIdsRef.current.clear();
  setFailedSubtitleIds([]);
  setLoadedSubtitle(null);
  setSubtitleTracks([]);
  setEmbeddedSubtitles([]);
  setActiveSubtitle(-1);
  setAudioTracksReady(false);
  const video = videoRef.current;
  if (video) applySubtitleTrack(video, undefined, hlsRef.current);
  setConfirmedEpisodeNumber(null);
  setPlaybackStarted(false);
  manifestDurationRef.current = null;
  sourceContextGenerationRef.current += 1;
  const switchTime = sourceSwitchTimeRef.current;
  sourceSwitchTimeRef.current = null;
  pendingSeekRef.current = switchTime;
  resumeAppliedRef.current = false;
  retryCountRef.current = 0;
  playRequestRef.current += 1;
  playAfterSeekRef.current = playIntentRef.current;
  mediaHintsRef.current = {
    ...mediaHintsRef.current,
    logicalOffset: 0,
    sourceReady: false,
    buffering: Boolean(baseVideoSrc),
    bufferingReason: baseVideoSrc ? "waiting" : null,
    error: null,
    durationHint: null,
  };
  renderPlaybackTime(null);
  syncMediaState(mediaHintsRef.current);
}
