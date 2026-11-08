import { appPath } from "../../core/runtime/hosting.ts";
import { isTitleType, type TitleType } from "./titles.ts";

export const WATCH_LANGUAGE_KEY = "lyra-watch-language";
export const WATCH_LANGUAGE_OPTIONS = [
  "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "hi", "ta", "te",
] as const;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "english",
  es: "spanish",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
  ja: "japanese",
  ko: "korean",
  zh: "chinese",
  hi: "hindi",
  ta: "tamil",
  te: "telugu",
  kn: "kannada",
  ml: "malayalam",
  bn: "bengali",
  mr: "marathi",
  pa: "punjabi",
  ur: "urdu",
  ru: "russian",
  ar: "arabic",
  tr: "turkish",
  pl: "polish",
  nl: "dutch",
  sv: "swedish",
  th: "thai",
  vi: "vietnamese",
  id: "indonesian",
  und: "original",
};

export function isWatchLanguage(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2,3}$/.test(value);
}

export function watchLanguageName(code: string | null | undefined): string {
  if (!code) return "original";
  return LANGUAGE_NAMES[code] || code;
}

export function readWatchLanguage(): string {
  try {
    const stored = localStorage.getItem(WATCH_LANGUAGE_KEY);
    return isWatchLanguage(stored) ? stored : "en";
  } catch {
    return "en";
  }
}

export function saveWatchLanguage(code: string): void {
  if (!isWatchLanguage(code)) return;
  try {
    localStorage.setItem(WATCH_LANGUAGE_KEY, code);
  } catch {}
}

export interface TitlePlayback {
  type: TitleType;
  id: string;
  season?: number | undefined;
}

export interface TitlePlaybackUrlOptions extends TitlePlayback {
  title: string;
  posterUrl: string;
  episode?: number | undefined;
  episodeCount?: number | undefined;
  year?: number | undefined;
  language?: string | undefined;
}

function wholeNumber(value: string | null, minimum: number): number | undefined {
  if (!value || !/^\d{1,5}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= minimum ? number : undefined;
}

export function parseTitlePlayback(params: URLSearchParams): TitlePlayback | null {
  const type = params.get("media_type");
  const id = params.get("tmdb_id") || "";
  if (!isTitleType(type) || !/^[1-9]\d{0,9}$/.test(id)) return null;
  if (type === "movie") return { type, id };
  const season = wholeNumber(params.get("season"), 0);
  return season === undefined ? null : { type, id, season };
}

export function appendTitleStreamParams(
  query: URLSearchParams,
  playback: TitlePlayback,
  episode: number,
): boolean {
  query.set("media_type", playback.type);
  query.set("tmdb_id", playback.id);
  if (playback.type === "movie") {
    query.delete("season");
    query.delete("episode");
    return true;
  }
  if (playback.season === undefined || !Number.isInteger(episode) || episode < 1) return false;
  query.set("season", String(playback.season));
  query.set("episode", String(episode));
  return true;
}

export function buildTitlePlaybackUrl({
  type,
  id,
  season,
  title,
  posterUrl,
  episode,
  episodeCount,
  year,
  language,
}: TitlePlaybackUrlOptions): string {
  const params = new URLSearchParams({
    title,
    poster: posterUrl,
    media_type: type,
    tmdb_id: id,
    language: isWatchLanguage(language) ? language : readWatchLanguage(),
  });
  if (type === "tv") {
    const episodeNumber = episode && episode > 0 ? episode : 1;
    params.set("season", String(season ?? 1));
    params.set("episode", String(episodeNumber));
    params.set("episodeName", `S${season ?? 1}E${episodeNumber}`);
    if (episodeCount && episodeCount > 0) params.set("episode_count", String(episodeCount));
  }
  if (year) params.set("year", String(year));
  return `${appPath("/stream/watch")}?${params.toString()}`;
}

export function titleResumeKey(playback: TitlePlayback, episode: number): string {
  return playback.type === "movie"
    ? `lyra-resume-watch-movie-${playback.id}`
    : `lyra-resume-watch-tv-${playback.id}-s${playback.season ?? 1}-e${episode}`;
}
