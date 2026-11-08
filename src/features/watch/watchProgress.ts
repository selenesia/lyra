import { isTitleType, type TitleType } from "./titles.ts";
import {
  buildTitlePlaybackUrl,
  isWatchLanguage,
  watchLanguageName,
  type TitlePlaybackUrlOptions,
} from "./watchPlayback.ts";

export const WATCH_PROGRESS_KEY = "lyra-watch-progress";
export const WATCH_PROGRESS_EVENT = "watch-progress-changed";
const MAX_RECORDS = 200;

export interface WatchProgress extends TitlePlaybackUrlOptions {
  language: string;
  currentTime: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
}

let progressCache: { raw: string; records: WatchProgress[] } | null = null;

function positiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

function validWatchProgress(records: unknown): WatchProgress[] {
  if (!Array.isArray(records)) return [];
  return records
    .filter((record): record is WatchProgress => {
      if (!record || typeof record !== "object") return false;
      const progress = record as WatchProgress;
      return (
        isTitleType(progress.type) &&
        typeof progress.id === "string" && /^[1-9]\d{0,9}$/.test(progress.id) &&
        typeof progress.title === "string" &&
        typeof progress.posterUrl === "string" &&
        isWatchLanguage(progress.language) &&
        Number.isFinite(progress.currentTime) && progress.currentTime > 0 &&
        Number.isFinite(progress.duration) && progress.duration >= 0 &&
        Number.isFinite(progress.updatedAt) && progress.updatedAt > 0 &&
        typeof progress.completed === "boolean" &&
        (progress.type === "movie" ||
          (Number.isInteger(progress.season) && (progress.season as number) >= 0 &&
            Number.isInteger(progress.episode) && (progress.episode as number) > 0)) &&
        positiveInteger(progress.episodeCount) &&
        positiveInteger(progress.year)
      );
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function readWatchProgress(): WatchProgress[] {
  try {
    const raw = localStorage.getItem(WATCH_PROGRESS_KEY) || "[]";
    if (progressCache?.raw === raw) return progressCache.records;
    const records = validWatchProgress(JSON.parse(raw));
    progressCache = { raw, records };
    return records;
  } catch {
    return [];
  }
}

function sameTitle(left: { type: TitleType; id: string }, right: { type: TitleType; id: string }): boolean {
  return left.type === right.type && left.id === right.id;
}

export function saveWatchProgress(progress: WatchProgress, resumeKey: string): void {
  if (!Number.isFinite(progress.currentTime) || progress.currentTime <= 0) return;
  try {
    localStorage.setItem(resumeKey, JSON.stringify({
      currentTime: progress.currentTime,
      timestamp: progress.updatedAt,
    }));
    const records = readWatchProgress();
    const previous = records.find((record) => sameTitle(record, progress));
    if (
      previous && previous.season === progress.season &&
      previous.episode === progress.episode &&
      previous.language === progress.language &&
      previous.currentTime === progress.currentTime &&
      previous.completed === progress.completed
    ) return;
    const next = [progress, ...records.filter((record) => !sameTitle(record, progress))].slice(0, MAX_RECORDS);
    const raw = JSON.stringify(next);
    localStorage.setItem(WATCH_PROGRESS_KEY, raw);
    progressCache = { raw, records: validWatchProgress(next) };
    window.dispatchEvent(new Event(WATCH_PROGRESS_EVENT));
  } catch {}
}

export function findWatchProgress(
  records: readonly WatchProgress[],
  title: { type: TitleType; id: string },
): WatchProgress | undefined {
  return records.find((record) => !record.completed && sameTitle(record, title));
}

export function watchProgressLabel(
  progress: WatchProgress,
  label: "resume" | "watching" = "resume",
): string {
  const seconds = Math.floor(progress.currentTime);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const clockMinutes = hours ? `${hours}:${String(minutes).padStart(2, "0")}` : String(minutes);
  const clock = `${clockMinutes}:${String(seconds % 60).padStart(2, "0")}`;
  const episode = progress.type === "tv" ? ` s${progress.season} e${progress.episode}` : "";
  return `${label}${episode} · ${clock}`;
}

export function watchProgressDetail(progress: WatchProgress): string {
  return watchLanguageName(progress.language);
}

export function watchResumeUrl(progress: WatchProgress): string {
  return `${buildTitlePlaybackUrl(progress)}&resume=${progress.currentTime}`;
}
