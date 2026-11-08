import { appPath } from "../runtime/hosting.ts";
import { parseTitlePlayback } from "../../features/watch/watchPlayback.ts";

const ANIME_PLAYBACK_PATH = appPath("/stream/anime");
const WATCH_PLAYBACK_PATH = appPath("/stream/watch");

function playbackUrl(realUrl: string): URL | null {
  try {
    const url = new URL(realUrl, "http://lyra.local");
    return url.pathname === ANIME_PLAYBACK_PATH || url.pathname === WATCH_PLAYBACK_PATH ? url : null;
  } catch {
    return null;
  }
}

function compactTitlePath(params: URLSearchParams): string | null {
  const playback = parseTitlePlayback(params);
  if (!playback) return null;
  const compact = new URLSearchParams();
  const title = params.get("title")?.replace(/\s+/g, " ").trim();
  if (title) compact.set("title", title);
  compact.set("media_type", playback.type);
  compact.set("tmdb_id", playback.id);
  if (playback.type === "tv") {
    compact.set("season", String(playback.season));
    const episode = params.get("episode")?.trim() || "";
    compact.set("episode", /^[1-9]\d*$/.test(episode) ? episode : "1");
  }
  const language = params.get("language")?.trim();
  if (language && /^[a-z]{2,3}$/.test(language)) compact.set("language", language);
  return `${WATCH_PLAYBACK_PATH}?${compact.toString()}`;
}

function titleDisplayLabel(params: URLSearchParams): string | null {
  const playback = parseTitlePlayback(params);
  const title = params.get("title")?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!playback || !title) return null;
  if (playback.type === "movie") return `movie: ${title}`;
  const episode = params.get("episode")?.trim();
  const episodeLabel = episode && /^[1-9]\d*$/.test(episode) ? ` / episode: ${episode}` : "";
  const seasonLabel = playback.season === 0 ? " / specials" : ` / season: ${playback.season}`;
  return `show: ${title}${seasonLabel}${episodeLabel}`;
}

export function compactPlaybackPath(realUrl: string): string | null {
  const url = playbackUrl(realUrl);
  if (!url) return null;

  const params = url.searchParams;
  if (params.has("media_type")) return compactTitlePath(params);
  if (url.pathname === WATCH_PLAYBACK_PATH) return null;
  const mal = params.get("mal_id")?.trim();
  const anilist = params.get("anilist_id")?.trim();
  if (!mal && !anilist) return null;

  const compact = new URLSearchParams();
  const title = params.get("title")?.replace(/\s+/g, " ").trim();
  if (title) compact.set("title", title);
  if (anilist) compact.set("anilist_id", anilist);
  if (mal) compact.set("mal_id", mal);

  const sourceEpisode = params.get("source_episode")?.trim();
  const episode =
    sourceEpisode && /^\d+$/.test(sourceEpisode) && Number(sourceEpisode) > 0
      ? sourceEpisode
      : params.get("episode")?.trim() || "";
  if (/^\d+$/.test(episode) && Number(episode) > 0)
    compact.set("episode", episode);

  const format = params.get("format")?.trim();
  if (format) compact.set("format", format);
  const formatKey = format?.toUpperCase();
  if (formatKey !== "MOVIE" && formatKey !== "MUSIC") {
    const season = params.get("season")?.trim();
    if (season && /^[1-9]\d*$/.test(season)) compact.set("season", season);
  }

  if (params.get("language") === "dub") compact.set("language", "dub");
  return `${ANIME_PLAYBACK_PATH}?${compact.toString()}`;
}

export function getPlaybackDisplayLabel(realUrl: string): string | null {
  try {
    const url = playbackUrl(realUrl);
    if (!url) return null;
    if (url.searchParams.has("media_type")) return titleDisplayLabel(url.searchParams);
    if (url.pathname === WATCH_PLAYBACK_PATH) return null;

    const title = url.searchParams
      .get("title")
      ?.replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!title) return null;

    const format = url.searchParams.get("format")?.trim().toUpperCase();
    const movie = format === "MOVIE" || format === "MUSIC";
    const episode = url.searchParams.get("episode")?.trim();
    const episodeLabel =
      !movie && episode && /^\d+$/.test(episode) ? ` / episode: ${episode}` : "";
    const season = url.searchParams.get("season")?.trim();
    const seasonLabel =
      !movie && season && /^[1-9]\d*$/.test(season) ? ` / season: ${season}` : "";
    return `anime: ${title}${seasonLabel}${episodeLabel}`;
  } catch {
    return null;
  }
}
