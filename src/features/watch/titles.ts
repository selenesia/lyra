import { RequestError } from "../../core/runtime/messages.ts";
import { encodeMochiUrl } from "../../core/runtime/utils.ts";

export type TitleType = "movie" | "tv";

export interface TitleCard {
  id: string;
  type: TitleType;
  title: string;
  year?: number | undefined;
  rating?: number | undefined;
  posterUrl?: string | undefined;
  posterSmallUrl?: string | undefined;
  backdropUrl?: string | undefined;
  overview?: string | undefined;
}

export interface TitlePage {
  page: number;
  totalPages: number;
  totalResults: number;
  results: TitleCard[];
}

export interface TitleRail {
  id: string;
  type: TitleType;
  results: TitleCard[];
}

export interface TitleSeasonSummary {
  number: number;
  name: string;
  episodeCount?: number | undefined;
  airDate?: string | undefined;
  posterUrl?: string | undefined;
}

export interface TitleDetails extends TitleCard {
  tagline?: string | undefined;
  genres: string[];
  releaseDate?: string | undefined;
  originalLanguage?: string | undefined;
  runtime?: number | undefined;
  numberOfSeasons?: number | undefined;
  seasons: TitleSeasonSummary[];
}

export interface TitleEpisode {
  number: number;
  name: string;
  overview?: string | undefined;
  stillUrl?: string | undefined;
  airDate?: string | undefined;
  rating?: number | undefined;
  runtime?: number | undefined;
}

export interface TitleSeason {
  seriesId: string;
  number: number;
  name: string;
  episodes: TitleEpisode[];
}

const MEMORY_TTL_MS = 10 * 60 * 1000;
const SESSION_PREFIX = "lyra-watch-metadata-";
const memory = new Map<string, { expiresAt: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();

export function isTitleType(value: unknown): value is TitleType {
  return value === "movie" || value === "tv";
}

export function titleKey(type: TitleType, id: string): string {
  return `${type}:tmdb:${id}`;
}

export function coverUrl(url: string | undefined): string | undefined {
  return url ? `/!cover!/${encodeMochiUrl(url)}/` : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function score(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function card(value: unknown): TitleCard | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = text(item.id);
  const title = text(item.title);
  if (!id || !/^\d+$/.test(id) || !title || !isTitleType(item.type)) return null;
  return {
    id,
    type: item.type,
    title,
    year: count(item.year),
    rating: score(item.rating),
    posterUrl: coverUrl(text(item.posterUrl)),
    posterSmallUrl: coverUrl(text(item.posterSmallUrl)),
    backdropUrl: coverUrl(text(item.backdropUrl)),
    overview: text(item.overview),
  };
}

function cards(value: unknown): TitleCard[] {
  return Array.isArray(value) ? value.flatMap((item) => card(item) ?? []) : [];
}

function page(value: unknown): TitlePage {
  const payload = (value || {}) as Record<string, unknown>;
  const results = cards(payload.results);
  const current = count(payload.page) || 1;
  return {
    page: current,
    totalPages: Math.max(current, count(payload.totalPages) || current),
    totalResults: count(payload.totalResults) ?? results.length,
    results,
  };
}

function details(value: unknown): TitleDetails {
  const base = card(value);
  if (!base) {
    throw new RequestError("title details are unavailable", { code: "WATCH_DETAILS_INVALID" });
  }
  const payload = value as Record<string, unknown>;
  return {
    ...base,
    tagline: text(payload.tagline),
    genres: Array.isArray(payload.genres) ? payload.genres.filter((genre): genre is string => typeof genre === "string") : [],
    releaseDate: text(payload.releaseDate),
    originalLanguage: text(payload.originalLanguage),
    runtime: count(payload.runtime),
    numberOfSeasons: count(payload.numberOfSeasons),
    seasons: Array.isArray(payload.seasons)
      ? payload.seasons.flatMap((item) => {
          const season = (item || {}) as Record<string, unknown>;
          const number = count(season.number);
          if (number === undefined) return [];
          return [{
            number,
            name: text(season.name) || (number === 0 ? "specials" : `season ${number}`),
            episodeCount: count(season.episodeCount),
            airDate: text(season.airDate),
            posterUrl: coverUrl(text(season.posterUrl)),
          }];
        })
      : [],
  };
}

function season(value: unknown): TitleSeason {
  const payload = (value || {}) as Record<string, unknown>;
  const number = count(payload.number);
  const seriesId = text(payload.seriesId);
  if (number === undefined || !seriesId || !Array.isArray(payload.episodes)) {
    throw new RequestError("season episodes are unavailable", { code: "WATCH_SEASON_INVALID" });
  }
  return {
    seriesId,
    number,
    name: text(payload.name) || `season ${number}`,
    episodes: payload.episodes.flatMap((item) => {
      const episode = (item || {}) as Record<string, unknown>;
      const episodeNumber = count(episode.number);
      if (!episodeNumber) return [];
      return [{
        number: episodeNumber,
        name: text(episode.name) || `episode ${episodeNumber}`,
        overview: text(episode.overview),
        stillUrl: coverUrl(text(episode.stillUrl)),
        airDate: text(episode.airDate),
        rating: score(episode.rating),
        runtime: count(episode.runtime),
      }];
    }),
  };
}

function rails(value: unknown): TitleRail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rail = (item || {}) as Record<string, unknown>;
    const id = text(rail.id);
    if (!id || !isTitleType(rail.type)) return [];
    const results = cards(rail.results);
    return results.length ? [{ id, type: rail.type, results }] : [];
  });
}

function readSession(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as { expiresAt?: number; value?: unknown };
    if ((stored.expiresAt || 0) > Date.now()) return stored.value;
    sessionStorage.removeItem(SESSION_PREFIX + key);
  } catch {}
  return undefined;
}

function writeSession(key: string, value: unknown, expiresAt: number): void {
  try {
    sessionStorage.setItem(SESSION_PREFIX + key, JSON.stringify({ expiresAt, value }));
  } catch {}
}

async function load<T>(
  path: string,
  params: Record<string, string>,
  normalize: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const key = `${path}?${query}`;
  const cached = memory.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  const stored = readSession(key);
  if (stored !== undefined) {
    const value = normalize(stored);
    memory.set(key, { expiresAt: Date.now() + MEMORY_TTL_MS, value });
    return value;
  }
  let request = pending.get(key) as Promise<T> | undefined;
  if (!request) {
    request = (async () => {
      const response = await fetch(`/api/watch/${path}?${query}`);
      if (!response.ok) {
        throw new RequestError("movie and show metadata is unavailable", {
          code: response.status === 404 ? "WATCH_TITLE_NOT_FOUND" : "WATCH_METADATA_UNAVAILABLE",
          status: response.status,
        });
      }
      const raw = (await response.json()) as unknown;
      const value = normalize(raw);
      const expiresAt = Date.now() + MEMORY_TTL_MS;
      memory.set(key, { expiresAt, value });
      writeSession(key, raw, expiresAt);
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
  }
  if (!signal) return request;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function fetchTitleHome(signal?: AbortSignal): Promise<TitleRail[]> {
  return load("home", {}, rails, signal);
}

export function discoverTitles(
  type: TitleType,
  category: string,
  pageNumber = 1,
  signal?: AbortSignal,
): Promise<TitlePage> {
  return load("discover", { type, category, page: String(pageNumber) }, page, signal);
}

export function searchTitles(
  type: TitleType,
  query: string,
  pageNumber = 1,
  signal?: AbortSignal,
): Promise<TitlePage> {
  return load("search", { type, q: query.trim(), page: String(pageNumber) }, page, signal);
}

export function fetchTitleDetails(type: TitleType, id: string, signal?: AbortSignal): Promise<TitleDetails> {
  return load("details", { type, id }, details, signal);
}

export function fetchTitleSeason(id: string, seasonNumber: number, signal?: AbortSignal): Promise<TitleSeason> {
  return load("season", { id, season: String(seasonNumber) }, season, signal);
}

export function playableSeasons(seasons: readonly TitleSeasonSummary[]): TitleSeasonSummary[] {
  return [...seasons]
    .filter((item) => item.episodeCount === undefined || item.episodeCount > 0)
    .sort((left, right) => (left.number === 0 ? 1 : 0) - (right.number === 0 ? 1 : 0) || left.number - right.number);
}

export function nextSeasonNumber(seasons: readonly TitleSeasonSummary[], current: number): number | null {
  const next = seasons
    .filter((item) => item.number > current && (item.episodeCount === undefined || item.episodeCount > 0))
    .sort((left, right) => left.number - right.number)[0];
  return current > 0 && next ? next.number : null;
}

export function resetTitleCache(): void {
  memory.clear();
  pending.clear();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(SESSION_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {}
}
