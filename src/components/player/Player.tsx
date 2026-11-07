import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
} from "preact/hooks";
import Hls from "hls.js";
import type { PlayerStatus } from "../../state/store.ts";
import { showToast } from "../../core/ui/toast.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import {
  qualityMenuLabel,
} from "../../core/media/hlsQuality.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  readMediaState,
  type MediaState,
  type MediaStateHints,
} from "../../core/media/mediaState.ts";
import {
  type AnimeSeason,
  isAnimeMovieFormat,
} from "../../features/anime/anime.ts";
import {
  ANIME_SUBTITLE_KEY,
  ANIME_SUBTITLE_PREFERENCES,
  readAnimeSubtitles,
  readAnimeLanguage,
  readAnimeQuality,
  readAnimeSetting,
} from "../../core/media/animeSettings.ts";
import {
  animeIdentityCacheKey,
  appendMegaPlayParams,
  hasMegaPlayIdentifier,
  normalizeAnimeIds,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";
import {
  IconPlay,
  IconPause,
  IconBack10s,
  IconForwards10s,
  IconFullScreen,
  IconDownsize,
} from "../icons";
import { attachSeekBar } from "./seekBar.ts";
import { attachCaptionLayout } from "./captionLayout.ts";
import {
  applySubtitleTrack,
  audioLabels,
  preferredAudioVersion,
  selectTrack,
  subtitleLabels,
  trackLabel,
  type AudioTrack,
  type SubtitleTrack,
} from "./tracks.ts";
import type { StreamInfoResponse, StreamQualityOption } from "./streamInfo.ts";
import {
  parsePlaybackEpisodeParts,
  type PlaybackEpisodePartRange,
  mergeEpisodeCount,
} from "./episodeParts.ts";
import {
  readPlayerStorage,
  startsIn4k,
  cleanDuration,
  type SkipRange,
  type SkipMarker,
  SUBTITLE_PREFERENCE_KEY,
  formatTime,
  activeSkipMarker,
  sameRenderedMediaState,
  resolvePlayerStatus,
  qualityName,
  type PlayerSelector,
} from "./playerState.ts";
import { attachPlayerShortcuts } from "./playerShortcuts.ts";
import { attachControlsActivity } from "./playerActivity.ts";
import { attachMediaEvents } from "./playerMediaEvents.ts";
import { switchPlayerLanguage, pickAudioTrack } from "./playerLanguage.ts";
import {
  loadSidecarSubtitle,
  pickSubtitle,
  checkSubtitlePreference,
} from "./playerSubtitles.ts";
import { loadStreamDetails } from "./playerStreamDetails.ts";
import {
  applyQualityPreference,
  pickQuality,
  probeRemote4k,
  syncQualityPreference,
} from "./playerQuality.ts";
import { preloadNextEpisode } from "./playerPreload.ts";
import { attachPlayerSource, resetSourceState } from "./playerSource.ts";
import {
  changePlayerEpisode,
  scheduleAutoNext,
  watchAnimeSettings,
  loadEpisodeCount,
} from "./playerEpisodes.ts";
import { persistPlayerProgress } from "./playerProgress.ts";
import {
  renderQualityMenu,
  renderSubtitleMenu,
  renderAudioMenu,
  renderLanguageMenu,
  renderEpisodeMenu,
} from "./playerMenus.tsx";
import {
  renderVolumeControl,
  renderAutoNextNotice,
} from "./playerControls.tsx";
import { togglePlayback } from "./playerPlayback.ts";

export default function Player() {
  const params = useRef(new URLSearchParams(window.location.search)).current;
  const title = params.get("title") || "";
  const poster = params.get("poster") || "";
  const hasEpisodeParam = params.has("episode");
  const initialEpisode = parseInt(params.get("episode") || "0", 10);
  const anilistId = parseInt(params.get("anilist_id") || "0", 10);
  const malId = parseInt(params.get("mal_id") || "0", 10);
  const anikotoEpisodeId = params.get("anikoto_episode_id") || "";
  const identityIds = useMemo(
    () =>
      normalizeAnimeIds({
        anilist: anilistId,
        mal: malId,
        anikotoEpisode: anikotoEpisodeId,
      }),
    [anilistId, malId, anikotoEpisodeId],
  );
  const episodeParts = useMemo(
    () => parsePlaybackEpisodeParts(params.get("episode_parts")),
    [params],
  );
  const initialPart = episodeParts.find(
    (part) => initialEpisode >= part.start && initialEpisode <= part.end,
  );
  const initialSourceEpisode = parseInt(
    params.get("source_episode") ||
      String(initialEpisode || (anikotoEpisodeId ? 1 : 0)),
    10,
  );
  const initialLanguage = preferredAudioVersion(
    readPlayerStorage("lyra-anime-audio") || "",
    params.has("language")
      ? params.get("language") === "dub"
        ? "dub"
        : "sub"
      : readAnimeLanguage(),
  );
  const [language, setLanguage] = useState<"sub" | "dub">(initialLanguage);
  const [prefer4k, setPrefer4k] = useState(() => readAnimeQuality() === "2160p");
  const [auto4k, setAuto4k] = useState(() => startsIn4k(readAnimeQuality()));
  const [requested4kContext, setRequested4kContext] = useState("");
  const [available4kSource, setAvailable4kSource] = useState("");
  const [failed4kContext, setFailed4kContext] = useState("");
  const [activeAnikotoEpisodeId, setActiveAnikotoEpisodeId] =
    useState(anikotoEpisodeId);
  const [activePartRange, setActivePartRange] =
    useState<PlaybackEpisodePartRange | null>(initialPart || null);
  const [activePartIds, setActivePartIds] = useState<AnimeIds>(
    initialPart?.ids || identityIds,
  );
  const [episodeOffset, setEpisodeOffset] = useState(
    initialPart
      ? initialPart.start - 1
      : Math.max(0, initialEpisode - initialSourceEpisode),
  );
  const playbackIds = useMemo(
    () =>
      normalizeAnimeIds({
        ...(activePartRange ? activePartIds : identityIds),
        anikotoEpisode: activeAnikotoEpisodeId,
      }),
    [identityIds, activePartRange, activePartIds, activeAnikotoEpisodeId],
  );
  const initialEpisodeCount = parseInt(params.get("episode_count") || "0", 10);
  const format = params.get("format") || "";
  const currentSeason = useMemo<AnimeSeason>(
    () => ({
      id: animeIdentityCacheKey({ ids: identityIds }),
      title,
      ids: identityIds,
      format,
      number: Number(params.get("season")) || 1,
      episodeCount: initialEpisodeCount,
      year: Number(params.get("year")) || undefined,
    }),
    [identityIds, title, format, params, initialEpisodeCount],
  );
  const [episodeNumber, setEpisodeNumber] = useState(
    hasEpisodeParam ? Math.max(0, initialEpisode) : anikotoEpisodeId ? 1 : 0,
  );
  const [confirmedEpisodeNumber, setConfirmedEpisodeNumber] = useState<
    number | null
  >(null);
  const sourceEpisodeNumber = Math.max(
    0,
    episodeNumber -
      (activePartRange ? activePartRange.start - 1 : episodeOffset),
  );
  const [episodeCount, setEpisodeCount] = useState(
    mergeEpisodeCount(initialEpisodeCount, initialEpisode),
  );
  const streamSessionRef = useRef("");
  if (!streamSessionRef.current) streamSessionRef.current = crypto.randomUUID();
  const episodeContext = [
    episodeNumber,
    sourceEpisodeNumber,
    playbackIds.anilist || 0,
    playbackIds.mal || 0,
    playbackIds.anikotoEpisode || "",
  ].join("|");
  const playbackContext = `${episodeContext}|${language}`;
  const request4k = requested4kContext === playbackContext && failed4kContext !== playbackContext;
  const start4k = auto4k && failed4kContext !== playbackContext;
  const qualityRequest = request4k ? "2160p" : start4k ? "auto" : "";
  const fallbackQuery = new URLSearchParams({
    episode: String(sourceEpisodeNumber),
    language,
    session: streamSessionRef.current,
  });
  if (qualityRequest) fallbackQuery.set("preferred_quality", qualityRequest);
  appendMegaPlayParams(fallbackQuery, playbackIds);
  const baseVideoSrc =
    (episodeNumber > 0 || Boolean(playbackIds.anikotoEpisode)) &&
    hasMegaPlayIdentifier(playbackIds)
      ? `/stream/anikoto?${fallbackQuery}`
      : "";
  const resumeKey = `lyra-resume-anikoto-${animeIdentityCacheKey({ ids: playbackIds })}-${episodeNumber}-${language}`;
  const episodeCountRef = useRef(episodeCount);
  episodeCountRef.current = episodeCount;
  const persistProgress = useCallback(
    (currentTime: number, duration: number, completed = false) => persistPlayerProgress({
    title, poster, identityIds, activeAnikotoEpisodeId, episodeNumber,
    sourceEpisodeNumber, params, episodeCountRef, format, language,
    episodeParts, resumeKey,
  }, currentTime, duration, completed),
    [
      title,
      poster,
      identityIds,
      activeAnikotoEpisodeId,
      episodeNumber,
      sourceEpisodeNumber,
      params,
      format,
      language,
      episodeParts,
      resumeKey,
    ],
  );
  const sourceContextKey = [
    episodeNumber,
    sourceEpisodeNumber,
    language,
    playbackIds.anilist || 0,
    playbackIds.mal || 0,
    playbackIds.anikotoEpisode || "",
    qualityRequest,
  ].join("|");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hlsSessionRef = useRef(0);
  const tracksSourceRef = useRef("");
  const mediaSessionRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNextTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nativeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const retryCountRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const sourceSwitchTimeRef = useRef<number | null>(null);
  const playAfterSeekRef = useRef(true);
  const playIntentRef = useRef(true);
  const playRequestRef = useRef(0);
  const sourceContextGenerationRef = useRef(0);
  const sourceContextRef = useRef(sourceContextKey);
  sourceContextRef.current = sourceContextKey;
  const resumeAppliedRef = useRef(false);
  const currentTimeRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef(performance.now());
  const firstSegmentRecordedRef = useRef(false);
  const firstFrameRecordedRef = useRef(false);
  const rebufferStartedAtRef = useRef<number | null>(null);
  const rebufferCountRef = useRef(0);
  const totalRebufferDurationMsRef = useRef(0);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const progressThumbRef = useRef<HTMLDivElement | null>(null);
  const timeDisplayRef = useRef<HTMLDivElement | null>(null);
  const seekBarRef = useRef<HTMLDivElement | null>(null);
  const seekPreviewRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const volumeDraggingRef = useRef(false);
  const lastVolumeRef = useRef(1);
  const languageRequestRef = useRef<AbortController | null>(null);
  const languageStreamInfoRef = useRef<{
    params: string;
    info: StreamInfoResponse;
  } | null>(null);
  const controlsFrameRef = useRef<number | null>(null);
  const [mediaState, setMediaState] = useState<MediaState>(() => {
    const storedVolumeValue = readPlayerStorage("lyra-anime-volume");
    const storedVolume =
      storedVolumeValue === null ? Number.NaN : Number(storedVolumeValue);
    const initialVolume = Number.isFinite(storedVolume)
      ? Math.max(0, Math.min(100, storedVolume))
      : 100;
    return {
      status: "loading",
      sourceReady: false,
      buffering: Boolean(baseVideoSrc),
      bufferingReason: baseVideoSrc ? "waiting" : null,
      playing: false,
      paused: true,
      ended: false,
      seeking: false,
      currentTime: null,
      duration: null,
      progress: null,
      buffered: [],
      volume: initialVolume,
      muted: false,
      playbackRate: 1,
      renderedWidth: 0,
      renderedHeight: 0,
      readyState: 0,
      networkState: 0,
      error: null,
    };
  });
  const mediaStateRef = useRef(mediaState);
  const mediaHintsRef = useRef<MediaStateHints>({
    sourceReady: false,
    buffering: Boolean(baseVideoSrc),
    bufferingReason: baseVideoSrc ? "waiting" : null,
    error: null,
    durationHint: null,
    logicalOffset: 0,
  });
  const manifestDurationRef = useRef<number | null>(null);
  const sourceGenerationRef = useRef(0);
  const [introMarker, setIntroMarker] = useState<SkipRange | null>(null);
  const [outroMarker, setOutroMarker] = useState<SkipRange | null>(null);
  const skipRangesRef = useRef({ intro: introMarker, outro: outroMarker });
  skipRangesRef.current = { intro: introMarker, outro: outroMarker };
  const [activeSkip, setActiveSkip] = useState<SkipMarker | null>(null);
  const bufferedRef = useRef<HTMLDivElement | null>(null);
  const paintedBufferedRef = useRef("");
  const [isFullscreen, setIsFullscreen] = useState(() =>
    Boolean(document.fullscreenElement),
  );
  const [showControls, setShowControls] = useState(true);
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [externalSubtitles, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [embeddedSubtitles, setEmbeddedSubtitles] = useState<SubtitleTrack[]>(
    [],
  );
  const failedSubtitleIdsRef = useRef(new Set<string>());
  const [failedSubtitleIds, setFailedSubtitleIds] = useState<string[]>([]);
  const [loadedSubtitle, setLoadedSubtitle] = useState<{
    source: string;
    id: string;
    url: string;
  } | null>(null);
  const subtitleTracks = useMemo(
    () =>
      [...embeddedSubtitles, ...externalSubtitles].filter(
        (track) => !failedSubtitleIds.includes(track.id),
      ),
    [externalSubtitles, embeddedSubtitles, failedSubtitleIds],
  );
  const subtitleMenuLabels = useMemo(
    () => subtitleLabels(subtitleTracks),
    [subtitleTracks],
  );
  const [infoRevision, setInfoRevision] = useState(0);
  const subtitleRetryRef = useRef(false);
  const [subtitlePreference, setSubtitlePreference] = useState(
    () =>
      readPlayerStorage(SUBTITLE_PREFERENCE_KEY) ||
      ANIME_SUBTITLE_PREFERENCES[readAnimeSubtitles()],
  );
  const preferenceNoticesRef = useRef(new Set<string>());
  const fallbackNoticesRef = useRef(new Set<string>());
  const fallbackPendingRef = useRef(false);
  const notify4kFallback = useCallback(() => {
    const video = videoRef.current;
    const key = `${animeIdentityCacheKey({ ids: playbackIds })}|${episodeNumber}`;
    if (
      !fallbackPendingRef.current || !video || video.paused ||
      video.readyState < 2 || fallbackNoticesRef.current.has(key)
    ) return;
    fallbackNoticesRef.current.add(key);
    showToast(
      "warning",
      "4k is unavailable; playing the best available quality",
      undefined,
      5000,
    );
  }, [playbackIds, episodeNumber]);
  const notifyPreference = useCallback((key: string, message: string) => {
    if (preferenceNoticesRef.current.has(key)) return;
    preferenceNoticesRef.current.add(key);
    showToast("error", message, undefined, 4000);
  }, []);
  const [subtitleChoice, setSubtitleChoice] = useState({ source: "", id: "" });
  const subtitleChoiceRef = useRef(subtitleChoice);
  subtitleChoiceRef.current = subtitleChoice;
  const selectedSubtitle = useMemo(
    () =>
      selectTrack(
        subtitleTracks,
        subtitlePreference,
        "subtitles",
        language,
        subtitleChoice.source === baseVideoSrc ? subtitleChoice.id : undefined,
      ),
    [
      subtitleTracks,
      subtitlePreference,
      language,
      subtitleChoice,
      baseVideoSrc,
    ],
  );
  const selectedSubtitleTrack = subtitleTracks[selectedSubtitle];
  const selectedSidecar = selectedSubtitleTrack?.src
    ? selectedSubtitleTrack
    : undefined;
  const [qualityOptions, setQualityOptions] = useState<StreamQualityOption[]>(
    [],
  );
  const [selectedQuality, setSelectedQuality] = useState(-1);
  const [activeQuality, setActiveQuality] = useState(-1);
  const [autoQuality, setAutoQuality] = useState(-1);
  const hasLocal4k = qualityOptions.some((option) => option.height >= 2160);
  const hasRemote4k = available4kSource === baseVideoSrc && !hasLocal4k &&
    failed4kContext !== playbackContext;
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState(-1);
  const [audioTracksReady, setAudioTracksReady] = useState(false);
  const [streamProvider, setStreamProvider] = useState<string | null>(null);
  const audioPreferencesRef = useRef({
    sub: readPlayerStorage("lyra-anime-audio-sub") || "",
    dub: readPlayerStorage("lyra-anime-audio-dub") || "",
  });
  const audioPreferenceRef = useRef(
    readPlayerStorage("lyra-anime-audio") || audioPreferencesRef.current[language],
  );
  const nextAudioLanguageRef = useRef(
    preferredAudioVersion(audioPreferenceRef.current, language),
  );
  const audioChoiceRef = useRef({ source: "", id: "" });
  const [activeSubtitle, setActiveSubtitle] = useState(-1);
  const [autoNext, setAutoNext] = useState<{
    episode: number;
    seconds: number;
  } | null>(null);
  const [preloadSource, setPreloadSource] = useState("");
  const [autoPlayNextEpisode, setAutoPlayNextEpisode] = useState(() =>
    readAnimeSetting("autoPlayNextEpisode"),
  );
  const [autoSkipIntroOutro, setAutoSkipIntroOutro] = useState(() =>
    readAnimeSetting("autoSkipIntroOutro"),
  );
  const autoSkippedMarkerRef = useRef<string | null>(null);
  const lastSubtitlePreferenceRef = useRef(
    subtitlePreference === "off" ? "" : subtitlePreference,
  );
  const [openSelector, setOpenSelector] = useState<PlayerSelector | null>(
    null,
  );
  const [episodeSelectorMounted, setEpisodeSelectorMounted] = useState(false);
  const episodeSelectorOpen = openSelector === "episodes";
  const episodeSelectorRendered = episodeSelectorOpen || episodeSelectorMounted;
  const [changingLanguage, setChangingLanguage] = useState(false);
  const [loadingEpisodeCount, setLoadingEpisodeCount] = useState(false);
  const [loadingStreamInfo, setLoadingStreamInfo] = useState(false);
  const selectorOpenRef = useRef(false);
  const reportPlayerStatus = useCallback((status: PlayerStatus) => {
    try {
      const parentLyra = window.parent?.Lyra;
      const tabId = parentLyra?.tabs?.find(
        (tab) => tab.iframe?.contentWindow === window,
      )?.id;
      if (typeof tabId === "number") {
        parentLyra?.setPlayerStatus?.(tabId, status);
      }
    } catch {}
  }, []);
  const videoSrc = baseVideoSrc;
  const fallbackFrom4k = useCallback(() => {
    if (!request4k && !start4k) return false;
    sourceSwitchTimeRef.current = Math.max(
      0, pendingSeekRef.current ?? videoRef.current?.currentTime ?? 0,
    );
    const nextLanguage = preferredAudioVersion(audioPreferenceRef.current, language);
    setFailed4kContext(`${episodeContext}|${nextLanguage}`);
    setLanguage(nextLanguage);
    return true;
  }, [request4k, start4k, episodeContext, language]);

  const unavailableMessage = useCallback((status?: number) => negativeMessage(
    status === 404
      ? isAnimeMovieFormat(format)
        ? "this anime is unavailable from all providers"
        : "this episode is unavailable from all providers"
      : "unable to load this episode; please try again",
  ), [format]);
  const displayDuration = mediaState.duration ?? 0;
  const buffering = mediaState.buffering;
  const loading = mediaState.status === "loading";
  const loadError = mediaState.error || "";
  const volume = mediaState.volume;
  const muted = mediaState.muted;
  const durationLabel =
    displayDuration > 0 ? formatTime(displayDuration) : "--:--";
  const displayDurationRef = useRef(displayDuration);
  const durationLabelRef = useRef(durationLabel);
  displayDurationRef.current = displayDuration;
  durationLabelRef.current = durationLabel;

  const renderBuffered = useCallback(
    (ranges: MediaState["buffered"], duration: number) => {
      const container = bufferedRef.current;
      if (!container) return;
      const segments =
        duration > 0
          ? ranges.map((range) => {
              const left = Math.max(0, Math.min(100, (range.start / duration) * 100));
              const right = Math.max(0, Math.min(100, (range.end / duration) * 100));
              return [left.toFixed(2), Math.max(0, right - left).toFixed(2)];
            })
          : [];
      const painted = segments.join("|");
      if (painted === paintedBufferedRef.current) return;
      paintedBufferedRef.current = painted;
      while (container.childElementCount > segments.length)
        container.lastElementChild!.remove();
      segments.forEach(([left, width], index) => {
        let bar = container.children[index] as HTMLElement | undefined;
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "seek-bar-buffered";
          container.append(bar);
        }
        bar.style.left = `${left}%`;
        bar.style.width = `${width}%`;
      });
    },
    [],
  );

  const syncMediaState = useCallback((patch: MediaStateHints = {}) => {
    mediaHintsRef.current = { ...mediaHintsRef.current, ...patch };
    const video = videoRef.current;
    if (!video) return;
    const next = readMediaState(video, mediaHintsRef.current);
    mediaStateRef.current = next;
    renderBuffered(next.buffered, next.duration ?? 0);
    const { intro, outro } = skipRangesRef.current;
    const skip = activeSkipMarker(next, intro, outro);
    setActiveSkip((previous) =>
      previous?.label === skip?.label && previous?.end === skip?.end
        ? previous
        : skip,
    );
    setMediaState((previous) =>
      sameRenderedMediaState(previous, next) ? previous : next,
    );
  }, [renderBuffered]);

  const paintedTimeRef = useRef({ pct: "", label: "", now: "" });
  const renderPlaybackTime = useCallback(
    (value: number | null, preview = false) => {
      const time =
        value !== null && Number.isFinite(value) ? Math.max(0, value) : null;
      const duration = displayDurationRef.current;
      const pct =
        duration > 0 && time !== null
          ? Math.max(0, Math.min(100, (time / duration) * 100))
          : 0;
      if (!preview) currentTimeRef.current = time;
      if (scrubbingRef.current && !preview) return;
      const painted = paintedTimeRef.current;
      const pctValue = `${pct.toFixed(3)}%`;
      if (painted.pct !== pctValue) {
        painted.pct = pctValue;
        if (progressFillRef.current) progressFillRef.current.style.width = pctValue;
        if (progressThumbRef.current) progressThumbRef.current.style.left = pctValue;
      }
      const label = `${time === null ? "--:--" : formatTime(time)} / ${durationLabelRef.current}`;
      if (painted.label !== label) {
        painted.label = label;
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = label;
        seekBarRef.current?.setAttribute("aria-valuetext", label);
      }
      const now = String(Math.floor(time ?? 0));
      if (painted.now !== now) {
        painted.now = now;
        seekBarRef.current?.setAttribute("aria-valuenow", now);
      }
    },
    [],
  );

  useEffect(() => {
    renderPlaybackTime(currentTimeRef.current);
  }, [displayDuration, durationLabel, renderPlaybackTime]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (autoNextTimerRef.current !== null) {
        clearInterval(autoNextTimerRef.current);
        autoNextTimerRef.current = null;
      }
      languageRequestRef.current?.abort();
      if (controlsFrameRef.current !== null) {
        cancelAnimationFrame(controlsFrameRef.current);
      }
    },
    [],
  );

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const lastActivityRef = useRef(0);
  const resetTimer = useCallback(() => {
    lastActivityRef.current = performance.now();
    setShowControls(true);
    if (hideTimerRef.current) return;
    const hideIfIdle = () => {
      const idleFor = performance.now() - lastActivityRef.current;
      if (idleFor < 3000) {
        hideTimerRef.current = setTimeout(hideIfIdle, 3000 - idleFor);
        return;
      }
      hideTimerRef.current = null;
      const video = videoRef.current;
      const focused = containerRef.current?.querySelector(
        ".player-controls :focus-visible",
      );
      if (
        video &&
        !video.paused &&
        !video.ended &&
        !selectorOpenRef.current &&
        !scrubbingRef.current &&
        !volumeDraggingRef.current &&
        !focused
      )
        setShowControls(false);
    };
    hideTimerRef.current = setTimeout(hideIfIdle, 3000);
  }, []);

  useEffect(() => {
    selectorOpenRef.current = openSelector !== null;
    if (openSelector) {
      clearHideTimer();
      setShowControls(true);
    } else resetTimer();
  }, [openSelector, resetTimer, clearHideTimer]);

  useEffect(() => {
    if (episodeSelectorOpen) setEpisodeSelectorMounted(true);
  }, [episodeSelectorOpen]);

  useEffect(() => {
    if (!openSelector) return;
    const close = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".player-control-popover")
      ) {
        setOpenSelector(null);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openSelector]);

  useEffect(() => loadEpisodeCount({
    playbackIds, format, episodeParts, setLoadingEpisodeCount, setEpisodeCount,
    episodeNumber,
  }), [
    episodeNumber,
    format,
    playbackIds.anilist,
    playbackIds.mal,
    playbackIds.anikotoEpisode,
    episodeParts.length,
  ]);

  const togglePlay = useCallback(() => togglePlayback({
    videoRef, playRequestRef, playIntentRef, hlsRef, playAfterSeekRef,
    syncMediaState,
  }), [syncMediaState]);

  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(seconds)) return;
      const durationLimit =
        displayDurationRef.current || cleanDuration(video.duration);
      const target =
        durationLimit > 0
          ? Math.max(0, Math.min(durationLimit, seconds))
          : Math.max(0, seconds);
      pendingSeekRef.current = target;
      playRequestRef.current += 1;
      hlsRef.current?.resumeBuffering();
      try {
        video.currentTime = target;
      } catch {}
    },
    [],
  );

  useEffect(() => {
    const bar = seekBarRef.current;
    const preview = seekPreviewRef.current;
    if (!bar || !preview) return;
    return attachSeekBar(bar, {
      duration: () => displayDurationRef.current,
      currentTime: () => pendingSeekRef.current ?? currentTimeRef.current,
      render: (time) => renderPlaybackTime(time, true),
      commit: seekTo,
      interaction: (active) => {
        scrubbingRef.current = active;
        resetTimer();
      },
      preview,
      format: formatTime,
    });
  }, [videoSrc, seekTo, renderPlaybackTime, resetTimer]);

  const handleVolume = useCallback(
    (event: Event) => {
      const volume = Number((event.target as HTMLInputElement).value);
      const video = videoRef.current;
      if (!video || !Number.isFinite(volume)) return;
      video.volume = Math.max(0, Math.min(1, volume / 100));
      video.muted = false;
      if (video.volume > 0) lastVolumeRef.current = video.volume;
      syncMediaState();
    },
    [syncMediaState],
  );

  const volumeSliderRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const slider = volumeSliderRef.current;
    if (!slider) return;
    const persistVolume = () => {
      const volume = Number(slider.value);
      if (!Number.isFinite(volume)) return;
      try {
        localStorage.setItem("lyra-anime-volume", String(volume));
      } catch {}
    };
    slider.addEventListener("change", persistVolume);
    return () => slider.removeEventListener("change", persistVolume);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = lastVolumeRef.current;
      video.muted = false;
    } else {
      lastVolumeRef.current = video.volume;
      video.muted = true;
    }
    syncMediaState();
  }, [syncMediaState]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;
    if (document.fullscreenElement === container) {
      void document.exitFullscreen().catch(() => {});
    } else if (container.requestFullscreen) {
      void container.requestFullscreen().catch(() => {});
    } else {
      video?.webkitEnterFullscreen?.();
    }
  }, []);

  const skipBack = useCallback(() => {
    const video = videoRef.current;
    if (video) seekTo((pendingSeekRef.current ?? video.currentTime) - 10);
  }, [seekTo]);

  const skipForward = useCallback(() => {
    const video = videoRef.current;
    if (video) seekTo((pendingSeekRef.current ?? video.currentTime) + 10);
  }, [seekTo]);

  const setSpeed = useCallback(
    (speed: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(speed)) return;
      video.playbackRate = speed;
      syncMediaState();
    },
    [syncMediaState],
  );

  const clearAutoNext = useCallback(() => {
    if (autoNextTimerRef.current !== null) {
      clearInterval(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    setAutoNext(null);
  }, []);

  useEffect(() => watchAnimeSettings({
    setAutoPlayNextEpisode, setAutoSkipIntroOutro, clearAutoNext,
    autoSkippedMarkerRef,
  }), [clearAutoNext]);

  useEffect(() => syncQualityPreference({
    prefer4k, auto4k, sourceSwitchTimeRef, pendingSeekRef, videoRef,
    setFailed4kContext, setPrefer4k, setAuto4k, setRequested4kContext,
    playbackContext,
  }), [prefer4k, auto4k, playbackContext]);

  const changeEpisode = useCallback(
    (nextEpisode: number, autoplay = false) => changePlayerEpisode({
    episodeNumber, episodeCount, setOpenSelector, clearAutoNext, videoRef,
    sourceContextGenerationRef, languageRequestRef, setChangingLanguage,
    playIntentRef, currentTimeRef, persistProgress, mediaStateRef,
    playAfterSeekRef, syncMediaState, setConfirmedEpisodeNumber,
    setEpisodeNumber, setLanguage, nextAudioLanguageRef,
    setActiveAnikotoEpisodeId, episodeParts, setActivePartRange,
    setActivePartIds, identityIds, setEpisodeOffset, currentSeason,
  }, nextEpisode, autoplay),
    [
      episodeCount,
      episodeNumber,
      currentSeason.number,
      persistProgress,
      episodeParts,
      identityIds,
      clearAutoNext,
      syncMediaState,
    ],
  );

  const startAutoNext = useCallback(() => scheduleAutoNext({
    episodeNumber, autoPlayNextEpisode, episodeCount, clearAutoNext,
    setAutoNext, autoNextTimerRef, changeEpisode,
  }), [
    autoPlayNextEpisode,
    clearAutoNext,
    changeEpisode,
    episodeCount,
    episodeNumber,
  ]);
  const startAutoNextRef = useRef(startAutoNext);
  startAutoNextRef.current = startAutoNext;

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = mediaStateRef.current.volume / 100;
    if (video.volume > 0) lastVolumeRef.current = video.volume;
  }, []);

  useLayoutEffect(() => resetSourceState({
    clearAutoNext, setAvailable4kSource, preferenceNoticesRef,
    fallbackPendingRef, subtitleRetryRef, failedSubtitleIdsRef,
    setFailedSubtitleIds, setLoadedSubtitle, setSubtitleTracks,
    setEmbeddedSubtitles, setActiveSubtitle, setAudioTracksReady, videoRef,
    hlsRef, setConfirmedEpisodeNumber, setPlaybackStarted, manifestDurationRef,
    sourceContextGenerationRef, sourceSwitchTimeRef, pendingSeekRef,
    resumeAppliedRef, retryCountRef, playRequestRef, playAfterSeekRef,
    playIntentRef, mediaHintsRef, baseVideoSrc, renderPlaybackTime,
    syncMediaState,
  }), [baseVideoSrc, clearAutoNext, renderPlaybackTime, syncMediaState]);

  useEffect(() => attachPlayerSource({
    videoRef, videoSrc, hlsSessionRef, tracksSourceRef, sourceContextKey,
    sessionStartedAtRef, firstSegmentRecordedRef, firstFrameRecordedRef,
    rebufferStartedAtRef, rebufferCountRef, totalRebufferDurationMsRef,
    episodeNumber, language, manifestDurationRef, syncMediaState,
    setQualityOptions, setSelectedQuality, setActiveQuality, setAutoQuality,
    setAudioTracksReady, setEmbeddedSubtitles, playIntentRef, playAfterSeekRef,
    setAudioTracks, setOpenSelector, setActiveAudioTrack, audioPreferenceRef,
    audioChoiceRef, prefer4k, request4k, start4k, hlsRef, sourceContextRef,
    pendingSeekRef, fallbackPendingRef, setInfoRevision, fallbackFrom4k,
    unavailableMessage,
  }), [episodeNumber, language, videoSrc, syncMediaState, prefer4k, request4k, start4k, fallbackFrom4k, unavailableMessage]);

  useEffect(() => probeRemote4k({
    videoRef, videoSrc, request4k, hasLocal4k, setAvailable4kSource,
  }), [videoSrc, request4k, hasLocal4k]);

  useEffect(() => preloadNextEpisode({
    preloadSource, videoSrc, episodeNumber, episodeCount, format, episodeParts,
    identityIds, language, streamSessionRef, auto4k,
  }), [
    preloadSource,
    videoSrc,
    episodeCount,
    episodeNumber,
    episodeParts,
    format,
    identityIds.anilist,
    identityIds.mal,
    language,
    auto4k,
  ]);

  const refreshAutoQuality = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    const level = Number(hls.nextAutoLevel);
    setAutoQuality(
      qualityOptions.some((option) => option.index === level) ? level : -1,
    );
  }, [qualityOptions]);

  const chooseQuality = useCallback(
    (index: number) => pickQuality({
    hlsRef, qualityOptions, setSelectedQuality, refreshAutoQuality,
    setOpenSelector, videoRef,
  }, index),
    [qualityOptions, refreshAutoQuality],
  );

  const chooseRemote4k = useCallback(() => {
    if (!hasRemote4k) return;
    sourceSwitchTimeRef.current = Math.max(
      0, pendingSeekRef.current ?? videoRef.current?.currentTime ?? 0,
    );
    setFailed4kContext("");
    setRequested4kContext(playbackContext);
    setOpenSelector(null);
  }, [hasRemote4k, playbackContext]);

  useEffect(() => applyQualityPreference({
    qualityOptions, notifyPreference, hlsRef, setSelectedQuality,
    refreshAutoQuality, setOpenSelector,
  }), [qualityOptions, refreshAutoQuality, notifyPreference]);

  useEffect(() => {
    const apply = () => {
      setSubtitleChoice({ source: "", id: "" });
      setSubtitlePreference(ANIME_SUBTITLE_PREFERENCES[readAnimeSubtitles()]);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ANIME_SUBTITLE_KEY) apply();
    };
    const onSetting = (event: Event) => {
      if ((event as CustomEvent).detail?.key === ANIME_SUBTITLE_KEY) apply();
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("animeSettingUpdated", onSetting);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("animeSettingUpdated", onSetting);
    };
  }, []);

  useEffect(() => checkSubtitlePreference({
    loadingStreamInfo, mediaState, subtitlePreference, subtitleTracks,
    notifyPreference,
  }), [
    subtitleTracks,
    subtitlePreference,
    loadingStreamInfo,
    mediaState.readyState,
    videoSrc,
    notifyPreference,
  ]);

  const chooseAudioTrack = useCallback(
    (index: number) => pickAudioTrack({
    audioTracks, audioTracksReady, tracksSourceRef, videoSrc, hlsRef,
    setActiveAudioTrack, audioChoiceRef, audioPreferenceRef,
    nextAudioLanguageRef, audioPreferencesRef, setOpenSelector,
  }, index),
    [audioTracks, audioTracksReady, videoSrc],
  );

  useEffect(() => loadStreamDetails({
    episodeNumber, playbackIds, setLoadingStreamInfo, sourceGenerationRef,
    sourceContextRef, manifestDurationRef, setIntroMarker, setOutroMarker,
    sourceEpisodeNumber, language, streamSessionRef, qualityRequest,
    languageStreamInfoRef, syncMediaState, setStreamProvider,
    fallbackPendingRef, requested4kContext, playbackContext, request4k,
    notify4kFallback, setSubtitleTracks, notifyPreference, mediaStateRef,
    unavailableMessage,
  }), [
    sourceEpisodeNumber,
    playbackIds.anilist,
    playbackIds.mal,
    playbackIds.anikotoEpisode,
    language,
    request4k,
    qualityRequest,
    prefer4k,
    requested4kContext,
    playbackContext,
    infoRevision,
    syncMediaState,
    notify4kFallback,
    unavailableMessage,
  ]);

  const applySubtitleSelection = useCallback(() => {
    const video = videoRef.current;
    if (!video || tracksSourceRef.current !== videoSrc) return;
    const selected = subtitleTracks[selectedSubtitle];
    setActiveSubtitle(
      applySubtitleTrack(video, selected, hlsRef.current)
        ? selectedSubtitle
        : -1,
    );
  }, [selectedSubtitle, subtitleTracks, videoSrc]);

  useLayoutEffect(() => {
    applySubtitleSelection();
  }, [applySubtitleSelection, videoSrc, loadedSubtitle]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.textTracks.addEventListener("addtrack", applySubtitleSelection);
    return () =>
      video.textTracks.removeEventListener("addtrack", applySubtitleSelection);
  }, [applySubtitleSelection]);

  const failSubtitle = useCallback(
    (id: string, notify = true, status?: number) => {
      if (
        sourceContextKey !== sourceContextRef.current ||
        failedSubtitleIdsRef.current.has(id)
      )
        return;
      failedSubtitleIdsRef.current.add(id);
      setFailedSubtitleIds([...failedSubtitleIdsRef.current]);
      recordStreamDiagnostic("subtitle_error", { status: status ?? null });
      const choice = subtitleChoiceRef.current;
      if (notify && choice.source === videoSrc && choice.id === id) {
        showToast("error", "selected subs are unavailable", undefined, 4000);
      }
      setActiveSubtitle(-1);
    },
    [sourceContextKey, videoSrc],
  );

  useEffect(() => loadSidecarSubtitle({
    selectedSidecar, loadedSubtitle, videoSrc, sourceContextKey,
    sourceContextRef, subtitleRetryRef, failSubtitle, setInfoRevision,
    setLoadedSubtitle,
  }), [
    selectedSidecar,
    loadedSubtitle,
    videoSrc,
    sourceContextKey,
    failSubtitle,
  ]);

  useEffect(() => {
    return () => {
      if (loadedSubtitle) URL.revokeObjectURL(loadedSubtitle.url);
    };
  }, [loadedSubtitle]);

  const chooseSubtitle = useCallback(
    (index: number) => pickSubtitle({
    subtitleTracks, lastSubtitlePreferenceRef, selectedSubtitle,
    setSubtitlePreference, setSubtitleChoice, videoSrc, setOpenSelector,
  }, index),
    [subtitleTracks, selectedSubtitle, videoSrc],
  );

  const toggleCaptions = useCallback(() => {
    if (subtitleTracks.length === 0) return;
    chooseSubtitle(
      selectedSubtitle >= 0
        ? -1
        : selectTrack(
            subtitleTracks,
            lastSubtitlePreferenceRef.current,
            "subtitles",
            language,
          ),
    );
  }, [subtitleTracks, selectedSubtitle, chooseSubtitle, language]);

  const changeLanguage = useCallback(
    (nextLanguage: "sub" | "dub") => switchPlayerLanguage({
    setOpenSelector, language, changingLanguage, episodeNumber, playbackIds,
    languageRequestRef, setChangingLanguage, videoRef, sourceEpisodeNumber,
    streamSessionRef, auto4k, sourceContextRef, sourceContextGenerationRef,
    sourceSwitchTimeRef, pendingSeekRef, playAfterSeekRef, playIntentRef,
    persistProgress, mediaStateRef, languageStreamInfoRef, nextAudioLanguageRef,
    audioPreferenceRef, audioPreferencesRef, setLanguage,
  }, nextLanguage),
    [
      language,
      changingLanguage,
      persistProgress,
      sourceEpisodeNumber,
      playbackIds,
      auto4k,
    ],
  );

  useEffect(() => attachMediaEvents({
    videoRef, mediaSessionRef, sourceContextKey, sourceContextRef,
    mediaStateRef, manifestDurationRef, pendingSeekRef, renderPlaybackTime,
    playIntentRef, playAfterSeekRef, hlsRef, playRequestRef, syncMediaState,
    rebufferStartedAtRef, totalRebufferDurationMsRef, rebufferCountRef,
    setPlaybackStarted, firstFrameRecordedRef, resetTimer, sessionStartedAtRef,
    notify4kFallback, autoNextTimerRef, startAutoNextRef, setPreloadSource,
    videoSrc, setConfirmedEpisodeNumber, episodeNumber, retryCountRef,
    nativeRetryTimerRef, fallbackFrom4k, resumeAppliedRef, resumeKey,
    initialEpisode, language, initialLanguage, params, persistProgress,
  }), [
    episodeNumber,
    resumeKey,
    videoSrc,
    renderPlaybackTime,
    syncMediaState,
    persistProgress,
    notify4kFallback,
    fallbackFrom4k,
    resetTimer,
  ]);

  useEffect(() => attachPlayerShortcuts({
    selectorOpenRef, containerRef, setOpenSelector, resetTimer, videoRef,
    displayDurationRef, seekTo, togglePlay, pendingSeekRef, syncMediaState,
    toggleMute, toggleFullscreen, toggleCaptions, setSpeed,
  }), [
    togglePlay,
    toggleMute,
    toggleFullscreen,
    toggleCaptions,
    seekTo,
    syncMediaState,
    setSpeed,
    resetTimer,
  ]);

  useEffect(() => {
    const updateFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
      resetTimer();
    };
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () =>
      document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, [resetTimer]);

  useEffect(() => attachControlsActivity({
    containerRef, controlsFrameRef, resetTimer, clearHideTimer, selectorOpenRef,
    scrubbingRef, volumeDraggingRef, setShowControls,
  }), [resetTimer, clearHideTimer]);

  useEffect(() => {
    const status = resolvePlayerStatus(
      mediaState.status,
      Boolean(videoSrc),
      loadingEpisodeCount || loadingStreamInfo || changingLanguage,
    );
    reportPlayerStatus(status);
  }, [
    changingLanguage,
    loadingEpisodeCount,
    loadingStreamInfo,
    mediaState.status,
    reportPlayerStatus,
    videoSrc,
  ]);

  useEffect(
    () => () => {
      reportPlayerStatus("idle");
    },
    [reportPlayerStatus],
  );

  useEffect(() => {
    if (title) {
      document.title = title;
    }
    if (poster) {
      let link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
      if (!link) {
        link = document.createElement("link");
        link.rel = "shortcut icon";
        document.head.appendChild(link);
      }
      link.href = poster;
    }

    const parentLyra = (window.parent as any)?.Lyra;
    if (parentLyra?.tabs) {
      const myTab = parentLyra.tabs.find(
        (t: any) => t.iframe?.contentWindow === window,
      );
      if (myTab) {
        if (title) myTab.title = title;
        if (poster) myTab.favicon = poster;
        parentLyra.renderTabs?.();
      }
    }
  }, [title, poster]);

  const controlsVisible =
    showControls ||
    mediaState.paused ||
    mediaState.ended ||
    Boolean(loadError) ||
    openSelector !== null ||
    !playbackStarted;
  useLayoutEffect(() => {
    const video = videoRef.current;
    const controls =
      containerRef.current?.querySelector<HTMLElement>(".player-controls");
    if (video && controls)
      return attachCaptionLayout(video, controls, controlsVisible);
  }, [controlsVisible, subtitleTracks, selectedSubtitle, loadedSubtitle]);
  const playControlActive = !mediaState.paused && !mediaState.ended;
  const requestedQuality =
    selectedQuality >= 0
      ? qualityOptions.find((option) => option.index === selectedQuality)
      : null;
  const autoQualityOption =
    autoQuality >= 0
      ? qualityOptions.find((option) => option.index === autoQuality)
      : null;
  const autoQualityName = autoQualityOption
    ? qualityName(autoQualityOption.label)
    : null;
  const selectedQualityLabel = qualityMenuLabel(
    selectedQuality >= 0 ? qualityName(requestedQuality?.label) : null,
    autoQualityName,
    selectedQuality >= 0 && selectedQuality !== activeQuality,
  );
  const audioMenuLabels = useMemo(
    () => audioLabels(audioTracks, streamProvider === "framex"),
    [audioTracks, streamProvider],
  );
  const selectedAudioTrack = audioTracks[activeAudioTrack]
    ? activeAudioTrack
    : selectTrack(audioTracks, audioPreferenceRef.current, "audio", language);
  const activeAudioLabel = streamProvider === null
    ? "audio"
    : audioMenuLabels[selectedAudioTrack] || "audio";
  useEffect(() => {
    syncMediaState();
  }, [introMarker, outroMarker, syncMediaState]);
  const pickerSeasons = useMemo(
    () => [
      { ...currentSeason, episodeCount: Math.max(episodeCount, episodeNumber) },
    ],
    [currentSeason, episodeCount, episodeNumber],
  );
  const closeSelector = useCallback(() => setOpenSelector(null), []);
  const playPickedEpisode = useCallback(
    (playerUrl: string) => {
      const next = new URL(playerUrl, window.location.origin);
      if (Number(next.searchParams.get("season")) === currentSeason.number) {
        changeEpisode(Number(next.searchParams.get("episode")));
      } else {
        window.location.assign(playerUrl);
      }
    },
    [currentSeason.number, changeEpisode],
  );
  const activeSkipKey = activeSkip
    ? `${activeSkip.label}:${activeSkip.end}`
    : null;
  const activeSkipEnd = activeSkip?.end ?? null;

  useEffect(() => {
    if (!autoSkipIntroOutro || !activeSkipKey || activeSkipEnd === null) {
      if (!autoSkipIntroOutro || !activeSkipKey) {
        autoSkippedMarkerRef.current = null;
      }
      return;
    }
    if (autoSkippedMarkerRef.current === activeSkipKey) return;
    autoSkippedMarkerRef.current = activeSkipKey;
    seekTo(activeSkipEnd);
  }, [activeSkipEnd, activeSkipKey, autoSkipIntroOutro, seekTo]);

  return (
    <div class="player-page is-visible">
      <div
        class={`video-container${controlsVisible ? "" : " hide-cursor"}`}
        data-player-status={mediaState.status}
        data-buffering-reason={mediaState.bufferingReason || undefined}
        data-seeking={mediaState.seeking ? "true" : "false"}
        aria-busy={mediaState.status === "loading" || mediaState.buffering}
        ref={containerRef}
      >
        <video
          ref={videoRef}
          playsInline
          aria-label={title || "video player"}
          preload="metadata"
          crossOrigin="anonymous"
          onClick={togglePlay}
        >
          {selectedSidecar &&
            loadedSubtitle?.source === videoSrc &&
            loadedSubtitle.id === selectedSidecar.id && (
              <track
                key={`${loadedSubtitle.url}:${infoRevision}`}
                data-track-id={selectedSidecar.id}
                kind={
                  selectedSidecar.kind === "captions" ? "captions" : "subtitles"
                }
                src={loadedSubtitle.url}
                label={`external ${trackLabel(selectedSidecar, selectedSubtitle, "subtitles")}`}
                srclang={selectedSidecar.language || "und"}
                onLoad={applySubtitleSelection}
                onError={() => failSubtitle(selectedSidecar.id)}
              />
            )}
        </video>
        {loadError && (
          <div class="video-loading is-error">
            <span class="loading-status">{loadError}</span>
          </div>
        )}

        {(loading || buffering) && !loadError && (
          <div class="video-loading" role="status" aria-label="loading video" />
        )}
        {activeSkip && (
          <button
            type="button"
            class="player-skip-marker"
            onClick={() => seekTo(activeSkip.end)}
          >
            {activeSkip.label}
          </button>
        )}
        {renderAutoNextNotice({
          autoNext, clearAutoNext, changeEpisode,
        })}

        <div class={`player-controls${controlsVisible ? "" : " is-hidden"}`}>
          <div
            ref={seekBarRef}
            class="seek-bar"
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={displayDuration || undefined}
            aria-label="seek"
            aria-disabled={!displayDuration}
          >
            <div ref={seekPreviewRef} class="seek-preview" hidden />
            <div ref={bufferedRef} />
            <div ref={progressFillRef} class="seek-bar-fill" />
            <div ref={progressThumbRef} class="seek-bar-thumb" />
          </div>

          <div class="controls-row">
            <button
              class="player-btn player-btn-play"
              aria-label={playControlActive ? "pause" : "play"}
              onClick={togglePlay}
            >
              {playControlActive ? (
                <IconPause size={24} />
              ) : (
                <IconPlay size={24} />
              )}
            </button>
            <button
              class="player-btn"
              aria-label="back 10 seconds"
              onClick={skipBack}
            >
              <IconBack10s size={24} />
            </button>
            <button
              class="player-btn"
              aria-label="forward 10 seconds"
              onClick={skipForward}
            >
              <IconForwards10s size={24} />
            </button>
            {renderVolumeControl({
              muted, volume, toggleMute, volumeSliderRef, handleVolume,
              volumeDraggingRef, resetTimer,
            })}
            <div ref={timeDisplayRef} class="time-display">
              --:-- / {durationLabel}
            </div>
            <div class="spacer" />
            {renderEpisodeMenu({
              format, episodeSelectorOpen, setOpenSelector,
              confirmedEpisodeNumber, setEpisodeSelectorMounted, title,
              episodeSelectorRendered, identityIds, poster, currentSeason,
              pickerSeasons, language, closeSelector, playPickedEpisode,
            })}
            {renderLanguageMenu({
              streamProvider, openSelector, setOpenSelector, changingLanguage,
              loadingStreamInfo, language, changeLanguage,
            })}
            {renderAudioMenu({
              streamProvider, audioTracksReady, audioTracks, openSelector,
              setOpenSelector, activeAudioLabel, loadingStreamInfo,
              selectedAudioTrack, chooseAudioTrack, audioMenuLabels,
            })}
            {renderSubtitleMenu({
              openSelector, setOpenSelector, activeSubtitle, subtitleTracks,
              selectedSubtitle, chooseSubtitle, subtitleMenuLabels,
            })}
            {renderQualityMenu({
              qualityOptions, hasRemote4k, openSelector, refreshAutoQuality,
              setOpenSelector, selectedQualityLabel, selectedQuality,
              chooseQuality, autoQualityName, chooseRemote4k,
            })}
            <button
              class="player-btn"
              aria-label={isFullscreen ? "exit fullscreen" : "fullscreen"}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <IconDownsize size={24} />
              ) : (
                <IconFullScreen size={24} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
