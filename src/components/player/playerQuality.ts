import Hls from "hls.js";
import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { fetchStreamInfo, type StreamQualityOption } from "./streamInfo.ts";
import { startsIn4k, type PlayerSelector } from "./playerState.ts";
import {
  preferredQualityLevel,
  applyQualitySelection,
} from "../../core/media/hlsQuality.ts";
import {
  readAnimeQuality,
  ANIME_QUALITY_KEY,
} from "../../core/media/animeSettings.ts";
import { showToast } from "../../core/ui/toast.ts";

interface QualityPreferenceContext {
  qualityOptions: StreamQualityOption[];
  notifyPreference: (key: string, message: string) => void;
  hlsRef: MutableRef<Hls | null>;
  setSelectedQuality: Dispatch<StateUpdater<number>>;
  refreshAutoQuality: () => void;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
}

export function applyQualityPreference({
  qualityOptions, notifyPreference, hlsRef, setSelectedQuality,
  refreshAutoQuality, setOpenSelector,
}: QualityPreferenceContext) {
  if (qualityOptions.length === 0) return;

  const checkPreference = () => {
    const preference = readAnimeQuality();
    if (
      preference !== "auto" &&
      preference !== "2160p" &&
      !qualityOptions.some(
        (level) => level.height === Number.parseInt(preference, 10),
      )
    ) {
      notifyPreference(`quality:${preference}`, "unavailable");
    }
  };
  const applyPreference = () => {
    const hls = hlsRef.current;
    if (!hls) return;
    const level = preferredQualityLevel(readAnimeQuality(), qualityOptions);
    if (
      !applyQualitySelection(
        hls,
        level,
        qualityOptions.map((option) => option.index),
      )
    )
      return;
    setSelectedQuality(level);
    if (level < 0) refreshAutoQuality();
    setOpenSelector(null);
    checkPreference();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === ANIME_QUALITY_KEY) applyPreference();
  };
  const onAnimeSettingUpdated = (event: Event) => {
    if ((event as CustomEvent).detail?.key === ANIME_QUALITY_KEY) {
      applyPreference();
    }
  };
  checkPreference();
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

interface QualityPickContext {
  hlsRef: MutableRef<Hls | null>;
  qualityOptions: StreamQualityOption[];
  setSelectedQuality: Dispatch<StateUpdater<number>>;
  refreshAutoQuality: () => void;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  videoRef: MutableRef<HTMLVideoElement | null>;
}

export function pickQuality({
  hlsRef, qualityOptions, setSelectedQuality, refreshAutoQuality,
  setOpenSelector, videoRef,
}: QualityPickContext, index: number) {
    const hls = hlsRef.current;
    if (!hls) return;
    const changed = hls.manualLevel !== index;
    if (
      !applyQualitySelection(
        hls,
        index,
        qualityOptions.map((option) => option.index),
      )
    )
      return;
    setSelectedQuality(index);
    if (index < 0) refreshAutoQuality();
    setOpenSelector(null);
    if (changed && videoRef.current?.paused) {
      showToast("success", "please unpause for quality change to apply");
    }
  }

interface Remote4kProbeContext {
  videoRef: MutableRef<HTMLVideoElement | null>;
  videoSrc: string;
  request4k: boolean;
  hasLocal4k: boolean;
  setAvailable4kSource: Dispatch<StateUpdater<string>>;
}

export function probeRemote4k({
  videoRef, videoSrc, request4k, hasLocal4k, setAvailable4kSource,
}: Remote4kProbeContext) {
  const video = videoRef.current;
  if (!video || !videoSrc || request4k || hasLocal4k) return;
  const controller = new AbortController();
  let started = false;
  const discover = () => {
    if (started || video.paused || video.readyState < 3) return;
    started = true;
    const query = new URLSearchParams(videoSrc.split("?", 2)[1]);
    query.set("discover_quality", "2160p");
    void fetchStreamInfo(query, controller.signal).then((info) => {
      if (!controller.signal.aborted && info.available_4k === true) {
        setAvailable4kSource(videoSrc);
      }
    }).catch(() => {});
  };
  video.addEventListener("playing", discover);
  discover();
  return () => {
    controller.abort();
    video.removeEventListener("playing", discover);
  };
}

interface QualityPreferenceSyncContext {
  prefer4k: boolean;
  auto4k: boolean;
  sourceSwitchTimeRef: MutableRef<number | null>;
  pendingSeekRef: MutableRef<number | null>;
  videoRef: MutableRef<HTMLVideoElement | null>;
  setFailed4kContext: Dispatch<StateUpdater<string>>;
  setPrefer4k: Dispatch<StateUpdater<boolean>>;
  setAuto4k: Dispatch<StateUpdater<boolean>>;
  setRequested4kContext: Dispatch<StateUpdater<string>>;
  playbackContext: string;
}

export function syncQualityPreference({
  prefer4k, auto4k, sourceSwitchTimeRef, pendingSeekRef, videoRef,
  setFailed4kContext, setPrefer4k, setAuto4k, setRequested4kContext,
  playbackContext,
}: QualityPreferenceSyncContext) {
  const apply = () => {
    const quality = readAnimeQuality();
    const next = quality === "2160p";
    const nextAuto4k = startsIn4k(quality);
    if (next === prefer4k && nextAuto4k === auto4k) return;
    sourceSwitchTimeRef.current = Math.max(0, pendingSeekRef.current ?? videoRef.current?.currentTime ?? 0);
    setFailed4kContext("");
    setPrefer4k(next);
    setAuto4k(nextAuto4k);
    setRequested4kContext(next ? playbackContext : "");
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ANIME_QUALITY_KEY) apply();
  };
  const onSetting = (event: Event) => {
    if ((event as CustomEvent).detail?.key === ANIME_QUALITY_KEY) apply();
  };
  window.addEventListener("storage", onStorage);
  document.addEventListener("animeSettingUpdated", onSetting);
  return () => {
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("animeSettingUpdated", onSetting);
  };
}
