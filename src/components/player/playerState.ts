import type { PlayerStatus } from "../../state/store.ts";
import type { MediaState } from "../../core/media/mediaState.ts";
import type { AnimeQuality } from "../../core/media/animeSettings.ts";

export const SUBTITLE_PREFERENCE_KEY = "lyra-anime-subtitle";

export function resolvePlayerStatus(
  status: PlayerStatus,
  hasSource: boolean,
  detailsLoading: boolean,
): PlayerStatus {
  if (!hasSource) return "idle";
  if (status === "error") return status;
  return detailsLoading ? "loading" : status;
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const formattedMinutes = minutes.toString().padStart(2, "0");
  const formattedSeconds = remainingSeconds.toString().padStart(2, "0");

  return hours > 0
    ? `${hours}:${formattedMinutes}:${formattedSeconds}`
    : `${minutes}:${formattedSeconds}`;
}

export function cleanDuration(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function sameRenderedMediaState(left: MediaState, right: MediaState): boolean {
  return (
    left.status === right.status &&
    left.sourceReady === right.sourceReady &&
    left.buffering === right.buffering &&
    left.bufferingReason === right.bufferingReason &&
    left.paused === right.paused &&
    left.ended === right.ended &&
    left.seeking === right.seeking &&
    left.duration === right.duration &&
    left.volume === right.volume &&
    left.muted === right.muted &&
    left.playbackRate === right.playbackRate &&
    left.error === right.error &&
    left.readyState >= 2 === right.readyState >= 2
  );
}

export interface SkipRange {
  start: number;
  end: number;
}

export interface SkipMarker {
  label: "skip intro" | "skip outro";
  end: number;
}

export function activeSkipMarker(
  state: MediaState,
  intro: SkipRange | null,
  outro: SkipRange | null,
): SkipMarker | null {
  const time = state.currentTime;
  if (state.seeking || time === null) return null;
  if (intro && time >= intro.start && time < intro.end)
    return { label: "skip intro", end: intro.end };
  if (outro && time >= outro.start && time < outro.end)
    return { label: "skip outro", end: outro.end };
  return null;
}

export function startsIn4k(quality: AnimeQuality): boolean {
  return quality === "auto" || quality === "2160p";
}

export function qualityLabel(height: number, bitrate: number): string {
  if (height > 0) {
    const rate =
      bitrate > 0 ? ` · ${(bitrate / 1_000_000).toFixed(1)} mbps` : "";
    return `${height === 2160 ? "4k" : `${height}p`}${rate}`;
  }
  return bitrate > 0 ? `${(bitrate / 1_000_000).toFixed(1)} mbps` : "source";
}

export function qualityName(label: string | undefined): string {
  return label?.split(" · ", 1)[0] || "source";
}

export function readPlayerStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export type PlayerSelector =
  | "episodes"
  | "language"
  | "subtitles"
  | "captionStyle"
  | "quality"
  | "audio"
  | "provider";
