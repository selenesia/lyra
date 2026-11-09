import { Gate, LoadFailure, TtlCache, jsonWeight } from "./cache.ts";
import { BROWSER_USER_AGENT, type FetchLike, finite, integer, list, record, requestJson, text } from "./upstream.ts";

export const FRAMEX_APIS = ["https://api.framextv.tech", "https://api.framextv.xyz"] as const;
const FRAMEX_HEADERS = {
  referer: "https://framextv.cc/",
  origin: "https://framextv.cc",
  "user-agent": BROWSER_USER_AGENT,
};

export type TitleType = "movie" | "tv";

export interface TitleCard {
  id: string;
  type: TitleType;
  title: string;
  year?: number;
  rating?: number;
  posterUrl?: string;
  posterSmallUrl?: string;
  backdropUrl?: string;
  overview?: string;
}

export interface TitlePage {
  page: number;
  totalPages: number;
  totalResults: number;
  results: TitleCard[];
}

export interface TitleSeasonSummary {
  number: number;
  name: string;
  episodeCount?: number;
  airDate?: string;
  posterUrl?: string;
  overview?: string;
}

export interface TitleDetails extends TitleCard {
  tagline?: string;
  genres: string[];
  releaseDate?: string;
  originalLanguage?: string;
  runtime?: number;
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  seasons: TitleSeasonSummary[];
  cast: Array<{ name: string; character?: string; profileUrl?: string }>;
  videos: Array<{ key: string; name: string; site: string; type: string }>;
  recommendations: TitleCard[];
}

export interface TitleEpisode {
  number: number;
  name: string;
  overview?: string;
  stillUrl?: string;
  airDate?: string;
  rating?: number;
  runtime?: number;
}

export interface TitleSeason {
  seriesId: string;
  number: number;
  name: string;
  overview?: string;
  posterUrl?: string;
  airDate?: string;
  episodes: TitleEpisode[];
}

export interface TitleRail {
  id: string;
  type: TitleType;
  results: TitleCard[];
}

export class TitleRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const DISCOVER_CATEGORIES: Record<TitleType, readonly string[]> = {
  movie: ["trending", "popular", "now_playing", "top_rated", "new_releases"],
  tv: ["trending", "popular", "on_the_air", "top_rated"],
};
const DISCOVER_SORTS = [
  "popularity.desc",
  "vote_average.desc",
  "primary_release_date.desc",
  "primary_release_date.asc",
];
const HOME_RAILS: Record<string, TitleType> = {
  trending_movies: "movie",
  popular_movies: "movie",
  popular_tv: "tv",
  new_releases: "movie",
  action_movies: "movie",
  scifi_movies: "movie",
  thriller_movies: "movie",
  comedy_movies: "movie",
};

function invalid(): never {
  throw new TitleRequestError("WATCH_REQUEST_INVALID");
}

export function titleType(value: string | null): TitleType {
  if (value === "movie" || value === "tv") return value;
  return invalid();
}

export function tmdbId(value: string | null): string {
  if (!value || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 4_294_967_295) return invalid();
  return value;
}

export function seasonNumber(value: string | null): number {
  if (value === null || !/^\d{1,4}$/.test(value)) return invalid();
  return Number(value);
}

function pageNumber(value: string | null): number {
  if (value === null || value === "") return 1;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 500) return invalid();
  return Number(value);
}

function imageUrl(value: unknown, size?: string): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  if (size && url.hostname === "image.tmdb.org") {
    url.pathname = url.pathname.replace(/^\/t\/p\/[^/]+\//, `/t/p/${size}/`);
  }
  return url.href;
}

function year(value: unknown, date?: unknown): number | undefined {
  const parsed = integer(value);
  if (parsed && parsed >= 1870 && parsed <= 2200) return parsed;
  const prefix = typeof date === "string" ? date.slice(0, 4) : "";
  return /^\d{4}$/.test(prefix) ? Number(prefix) : undefined;
}

function rating(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed > 0 && parsed <= 10 ? Math.round(parsed * 10) / 10 : undefined;
}

function isoDate(value: unknown): string | undefined {
  const date = text(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function idText(value: unknown): string | undefined {
  const raw = typeof value === "number" ? String(value) : text(value);
  return raw && /^[1-9]\d{0,9}$/.test(raw) ? raw : undefined;
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

export function normalizeCard(value: unknown, fallbackType?: TitleType): TitleCard | null {
  const card = record(value);
  if (!card) return null;
  const type = card.type === "movie" || card.type === "tv" ? card.type : fallbackType;
  const id = idText(card.id);
  const title = text(card.title) ?? text(card.name);
  if (!type || !id || !title) return null;
  const poster = card.poster ?? card.image ?? card.poster_path;
  const normalized: TitleCard = { id, type, title };
  assign(normalized, "year", year(card.year, card.release_date ?? card.releaseDate ?? card.first_air_date));
  assign(normalized, "rating", rating(card.rating ?? card.vote_average));
  assign(normalized, "posterUrl", imageUrl(poster, "w342"));
  assign(normalized, "posterSmallUrl", imageUrl(poster, "w185"));
  assign(normalized, "backdropUrl", imageUrl(card.backdrop ?? card.backdrop_path, "w780"));
  assign(normalized, "overview", text(card.overview));
  return normalized;
}

function normalizeCards(values: unknown, fallbackType?: TitleType, limit = 60): TitleCard[] {
  const seen = new Set<string>();
  const cards: TitleCard[] = [];
  for (const value of list(values)) {
    const card = normalizeCard(value, fallbackType);
    if (!card || seen.has(`${card.type}:${card.id}`)) continue;
    seen.add(`${card.type}:${card.id}`);
    cards.push(card);
    if (cards.length >= limit) break;
  }
  return cards;
}

export function normalizePage(value: unknown, type?: TitleType): TitlePage {
  const payload = record(value);
  if (!payload || payload.success === false || !Array.isArray(payload.results)) {
    throw new LoadFailure("invalid_payload");
  }
  const results = normalizeCards(payload.results, type);
  const page = integer(payload.page) ?? 1;
  return {
    page,
    totalPages: Math.max(page, integer(payload.totalPages ?? payload.total_pages) ?? page),
    totalResults: Math.max(results.length, integer(payload.totalResults ?? payload.total_results) ?? 0),
    results,
  };
}

export function normalizeDetails(value: unknown, type: TitleType, id: string): TitleDetails {
  const payload = record(value);
  if (!payload || payload.success !== true) throw new LoadFailure("invalid_payload");
  const card = normalizeCard({ ...payload, type: payload.type ?? type }, type);
  if (!card || card.id !== id || card.type !== type) throw new LoadFailure("mismatch");
  const details: TitleDetails = {
    ...card,
    genres: list(payload.genres)
      .map((genre) => (typeof genre === "string" ? genre : text(record(genre)?.name)))
      .filter((genre): genre is string => Boolean(genre)),
    seasons: [],
    cast: [],
    videos: [],
    recommendations: normalizeCards(payload.recommendations ?? payload.similar, undefined, 20),
  };
  const releaseDate = isoDate(payload.releaseDate ?? payload.release_date ?? payload.first_air_date);
  assign(details, "posterUrl", imageUrl(payload.poster ?? payload.poster_path, "w500"));
  assign(details, "backdropUrl", imageUrl(payload.backdrop ?? payload.backdrop_path, "w1280"));
  assign(details, "tagline", text(payload.tagline));
  assign(details, "releaseDate", releaseDate);
  assign(details, "year", details.year ?? year(undefined, releaseDate));
  const language = text(payload.originalLanguage ?? payload.original_language)?.toLowerCase();
  assign(details, "originalLanguage", language && /^[a-z]{2,3}$/.test(language) ? language : undefined);
  const runtime = integer(payload.runtime);
  assign(details, "runtime", type === "movie" && runtime && runtime > 0 ? runtime : undefined);
  const seasons = integer(payload.numberOfSeasons ?? payload.number_of_seasons);
  assign(details, "numberOfSeasons", seasons && seasons > 0 ? seasons : undefined);
  const episodes = integer(payload.numberOfEpisodes ?? payload.number_of_episodes);
  assign(details, "numberOfEpisodes", episodes && episodes > 0 ? episodes : undefined);
  if (type === "tv") {
    const seen = new Set<number>();
    for (const value of list(payload.seasons)) {
      const season = record(value);
      const number = integer(season?.number ?? season?.season_number);
      if (!season || number === undefined || number < 0 || seen.has(number)) continue;
      seen.add(number);
      const summary: TitleSeasonSummary = {
        number,
        name: text(season.name) ?? (number === 0 ? "specials" : `season ${number}`),
      };
      const count = integer(season.episodeCount ?? season.episode_count);
      assign(summary, "episodeCount", count !== undefined && count >= 0 ? count : undefined);
      assign(summary, "airDate", isoDate(season.airDate ?? season.air_date));
      assign(summary, "posterUrl", imageUrl(season.poster ?? season.poster_path, "w342"));
      assign(summary, "overview", text(season.overview));
      details.seasons.push(summary);
    }
    details.seasons.sort((left, right) => left.number - right.number);
  }
  for (const value of list(payload.cast).slice(0, 20)) {
    const member = record(value);
    const name = text(member?.name);
    if (!member || !name) continue;
    const cast: TitleDetails["cast"][number] = { name };
    assign(cast, "character", text(member.character));
    assign(cast, "profileUrl", imageUrl(member.profile ?? member.profile_path, "w185"));
    details.cast.push(cast);
  }
  for (const value of list(payload.videos ?? payload.trailers).slice(0, 10)) {
    const video = record(value);
    const key = text(video?.key);
    const site = text(video?.site);
    if (!video || !key || !site || !/^[\w-]{1,64}$/.test(key)) continue;
    details.videos.push({ key, site, name: text(video.name) ?? "", type: text(video.type) ?? "" });
  }
  return details;
}

export function normalizeSeason(value: unknown, seriesId: string, number: number): TitleSeason {
  const payload = record(value);
  if (!payload || payload.success === false) throw new LoadFailure("invalid_payload");
  const responseNumber = integer(payload.number ?? payload.season_number);
  if (responseNumber !== number || !Array.isArray(payload.episodes)) throw new LoadFailure("mismatch");
  const season: TitleSeason = {
    seriesId,
    number,
    name: text(payload.name) ?? (number === 0 ? "specials" : `season ${number}`),
    episodes: [],
  };
  assign(season, "overview", text(payload.overview));
  assign(season, "posterUrl", imageUrl(payload.poster ?? payload.poster_path, "w342"));
  assign(season, "airDate", isoDate(payload.airDate ?? payload.air_date));
  const seen = new Set<number>();
  for (const value of payload.episodes) {
    const episode = record(value);
    const episodeNumber = integer(episode?.number ?? episode?.episode_number);
    const episodeSeason = integer(episode?.season_number);
    if (
      !episode ||
      episodeNumber === undefined ||
      episodeNumber < 1 ||
      seen.has(episodeNumber) ||
      (episodeSeason !== undefined && episodeSeason !== number)
    ) {
      continue;
    }
    seen.add(episodeNumber);
    const normalized: TitleEpisode = {
      number: episodeNumber,
      name: text(episode.name) ?? `episode ${episodeNumber}`,
    };
    assign(normalized, "overview", text(episode.overview));
    assign(normalized, "stillUrl", imageUrl(episode.still ?? episode.still_path, "w300"));
    assign(normalized, "airDate", isoDate(episode.airDate ?? episode.air_date));
    assign(normalized, "rating", rating(episode.rating ?? episode.vote_average));
    const runtime = integer(episode.runtime);
    assign(normalized, "runtime", runtime && runtime > 0 ? runtime : undefined);
    season.episodes.push(normalized);
  }
  season.episodes.sort((left, right) => left.number - right.number);
  return season;
}

export function normalizeHome(value: unknown): TitleRail[] {
  const payload = record(value);
  const rails = record(payload?.rails);
  if (!payload || payload.success === false || !rails) throw new LoadFailure("invalid_payload");
  const normalized: TitleRail[] = [];
  for (const [id, type] of Object.entries(HOME_RAILS)) {
    const rail = record(rails[id]);
    if (!rail) continue;
    const results = normalizeCards(rail.results, type, 40);
    if (results.length > 0) normalized.push({ id, type, results });
  }
  if (normalized.length === 0) throw new LoadFailure("empty");
  return normalized;
}

export interface TitleQuery {
  kind: "home" | "discover" | "search" | "details" | "season";
  upstreamPath: string;
  cacheKey: string;
  ttlMs: number;
  normalize: (payload: unknown) => unknown;
}

export function parseTitleQuery(pathname: string, params: URLSearchParams): TitleQuery {
  const route = pathname.replace(/^\/api\/watch\//, "");
  if (route === "home") {
    return { kind: "home", upstreamPath: "/api/home", cacheKey: "home", ttlMs: 5 * 60_000, normalize: normalizeHome };
  }
  if (route === "discover") {
    const type = titleType(params.get("type"));
    const query = new URLSearchParams({ type });
    const category = params.get("category");
    if (category) {
      if (!DISCOVER_CATEGORIES[type].includes(category)) invalid();
      query.set("category", category);
    }
    const genre = params.get("genre");
    if (genre) {
      if (!/^\d{1,6}$/.test(genre)) invalid();
      query.set("genre", genre);
    }
    const releaseYear = params.get("year");
    if (releaseYear) {
      if (!/^\d{4}$/.test(releaseYear) || Number(releaseYear) < 1870 || Number(releaseYear) > 2200) invalid();
      query.set("year", releaseYear);
    }
    const sort = params.get("sort");
    if (sort) {
      if (!DISCOVER_SORTS.includes(sort)) invalid();
      query.set("sort", sort);
    }
    const minRating = params.get("min_rating");
    if (minRating) {
      if (!/^(?:10|\d)(?:\.\d)?$/.test(minRating)) invalid();
      query.set("min_rating", minRating);
    }
    query.set("page", String(pageNumber(params.get("page"))));
    return {
      kind: "discover",
      upstreamPath: `/api/discover?${query}`,
      cacheKey: `discover:${query}`,
      ttlMs: 10 * 60_000,
      normalize: (payload) => normalizePage(payload, type),
    };
  }
  if (route === "search") {
    const type = titleType(params.get("type"));
    const q = (params.get("q") ?? "").replace(/\s+/g, " ").trim();
    if (!q || q.length > 120) invalid();
    const query = new URLSearchParams({ q, type, page: String(pageNumber(params.get("page"))) });
    return {
      kind: "search",
      upstreamPath: `/api/search?${query}`,
      cacheKey: `search:${type}:${q.toLowerCase()}:${query.get("page")}`,
      ttlMs: 10 * 60_000,
      normalize: (payload) => normalizePage(payload, type),
    };
  }
  if (route === "details") {
    const type = titleType(params.get("type"));
    const id = tmdbId(params.get("id"));
    return {
      kind: "details",
      upstreamPath: `/api/details?${new URLSearchParams({ id, type })}`,
      cacheKey: `details:${type}:${id}`,
      ttlMs: 10 * 60_000,
      normalize: (payload) => normalizeDetails(payload, type, id),
    };
  }
  if (route === "season") {
    const id = tmdbId(params.get("id"));
    const season = seasonNumber(params.get("season"));
    return {
      kind: "season",
      upstreamPath: `/api/season?${new URLSearchParams({ id, season: String(season) })}`,
      cacheKey: `season:${id}:${season}`,
      ttlMs: 10 * 60_000,
      normalize: (payload) => normalizeSeason(payload, id, season),
    };
  }
  throw new TitleRequestError("WATCH_ROUTE_NOT_FOUND");
}

export function createTitleMetadata(fetchImpl: FetchLike, gate: Gate) {
  const responses = new TtlCache<string, { value: unknown; expiresAt: number }>({
    ttlMs: 10 * 60_000,
    maxWeight: 24 * 1024 * 1024,
    weigh: (entry) => jsonWeight(entry.value),
  });
  const failures = new TtlCache<string, string>({ ttlMs: 15_000, maxWeight: 10_000 });
  let preferred = 0;

  const fetchUpstream = async (path: string): Promise<unknown> => {
    let failure = "network";
    for (let attempt = 0; attempt < FRAMEX_APIS.length; attempt += 1) {
      const index = (preferred + attempt) % FRAMEX_APIS.length;
      try {
        const result = await requestJson(fetchImpl, `${FRAMEX_APIS[index]}${path}`, {
          headers: FRAMEX_HEADERS,
          timeoutMs: 10_000,
        });
        if (result.status === 404 || result.status === 400) throw new LoadFailure("not_found");
        if (result.status < 200 || result.status >= 300) throw new LoadFailure(`status_${result.status}`);
        preferred = index;
        return result.body;
      } catch (error) {
        failure = error instanceof LoadFailure ? error.reason : "network";
        if (failure === "not_found") throw error;
      }
    }
    throw new LoadFailure(failure);
  };

  return {
    get size() {
      return responses.size;
    },
    failures: () => failures.size,
    async load(query: TitleQuery): Promise<unknown> {
      const failed = failures.get(query.cacheKey);
      if (failed) throw new LoadFailure(failed);
      try {
        const entry = await responses.load(query.cacheKey, async () => ({
          value: query.normalize(await gate.run(10_000, () => fetchUpstream(query.upstreamPath))),
          expiresAt: Date.now() + query.ttlMs,
        }));
        if (entry.expiresAt <= Date.now()) {
          responses.delete(query.cacheKey);
          return this.load(query);
        }
        return entry.value;
      } catch (error) {
        const reason = error instanceof LoadFailure ? error.reason : "invalid_payload";
        if (reason !== "capacity") failures.set(query.cacheKey, reason);
        throw new LoadFailure(reason);
      }
    },
  };
}
