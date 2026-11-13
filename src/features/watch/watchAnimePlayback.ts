import { readAnimeLanguage } from "../../core/media/animeSettings.ts";
import { buildAnimePlaybackUrl } from "../anime/animePlayback.ts";
import { resolveAnimeIdentity } from "../anime/animeIdentity.ts";
import { fetchTitleDetails } from "./titles.ts";
import { parseTitlePlayback } from "./watchPlayback.ts";

export async function resolveWatchAnimePlayback(url: URL): Promise<URL | null> {
  const playback = parseTitlePlayback(url.searchParams);
  if (playback?.type !== "movie") return null;
  const signal = AbortSignal.timeout(10_000);
  try {
    const movie = await fetchTitleDetails("movie", playback.id, signal);
    if (!movie.genres.some((genre) => genre.toLowerCase() === "animation")) return null;
    const identity = await resolveAnimeIdentity({
      title: movie.title,
      year: movie.year,
      format: "MOVIE",
    }, signal);
    if (!identity?.ids.anilist && !identity?.ids.mal) return null;
    const animeUrl = new URL(buildAnimePlaybackUrl({
      title: movie.title,
      posterUrl: url.searchParams.get("poster") || movie.posterUrl || "",
      ids: identity.ids,
      episode: 1,
      episodeCount: 1,
      year: identity.year || movie.year,
      format: "MOVIE",
      language: readAnimeLanguage(),
    }), url.origin);
    for (const key of ["resume", "party"]) {
      const value = url.searchParams.get(key);
      if (value) animeUrl.searchParams.set(key, value);
    }
    return animeUrl;
  } catch {
    return null;
  }
}
