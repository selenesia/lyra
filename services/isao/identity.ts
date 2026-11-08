import { negativeMessage } from "../../src/core/runtime/messages.ts";
import type { AnimeSources } from "./anime.ts";
import { type FetchLike, getJson, integer, list, record, text } from "./upstream.ts";

const KITSU_BASE = "https://kitsu.io/api/edge";
const IDENTITY_USER_AGENT = "lyra-anime-identity/1.0";

export const ANIME_ID_PROVIDERS = [
  "anilist",
  "mal",
  "anidb",
  "kitsu",
  "tmdb",
  "tmdbSeason",
  "imdb",
  "tvdb",
  "tvdbSeason",
  "animePlanet",
  "liveChart",
  "animeNewsNetwork",
  "aniSearch",
  "simkl",
  "animeCountdown",
  "anikoto",
  "anikotoEpisode",
] as const;

export type AnimeIdProvider = (typeof ANIME_ID_PROVIDERS)[number];
export type AnimeIds = Partial<Record<AnimeIdProvider, string>>;

export interface AnimeIdentity {
  ids: AnimeIds;
  titles: string[];
  year: number | null;
  season: string | null;
  format: string | null;
  episodes: number | null;
  mappingConfidence: string | null;
  mappingSources: string[];
  mappingWarnings: string[];
}

export interface IdentityRequest {
  ids: Record<string, unknown>;
  anilistId: unknown;
  malId: unknown;
  title: string | undefined;
  year: number | undefined;
  season: string | undefined;
  format: string | undefined;
}

export function parseIdentityRequest(body: unknown): IdentityRequest | null {
  const value = record(body);
  if (!value) return null;
  const ids = value.ids === undefined || value.ids === null ? {} : record(value.ids);
  if (!ids) return null;
  for (const key of ["title", "season", "format"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") return null;
  }
  if (value.year !== undefined && value.year !== null && integer(value.year) === undefined) return null;
  return {
    ids,
    anilistId: value.anilist_id ?? value.anilistId,
    malId: value.mal_id ?? value.malId,
    title: typeof value.title === "string" ? value.title : undefined,
    year: typeof value.year === "number" ? value.year : undefined,
    season: typeof value.season === "string" ? value.season : undefined,
    format: typeof value.format === "string" ? value.format : undefined,
  };
}

export function idValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("-") || /^0+$/.test(trimmed)) return undefined;
    return trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return String(value);
  return undefined;
}

function setId(ids: AnimeIds, provider: AnimeIdProvider, value: string | undefined): void {
  if (value !== undefined && ids[provider] === undefined) ids[provider] = value;
}

export function normalizedIds(request: IdentityRequest): AnimeIds {
  const ids: AnimeIds = {};
  for (const provider of ANIME_ID_PROVIDERS) setId(ids, provider, idValue(request.ids[provider]));
  setId(ids, "anilist", idValue(request.anilistId));
  setId(ids, "mal", idValue(request.malId));
  return ids;
}

export function identityCacheKey(request: IdentityRequest): string {
  const ids = normalizedIds(request);
  return [
    ANIME_ID_PROVIDERS.map((provider) => `${provider}=${ids[provider] ?? ""}`).join("&"),
    (request.title ?? "").trim().toLowerCase(),
    request.year ?? 0,
    (request.season ?? "").toLowerCase(),
    (request.format ?? "").toLowerCase(),
  ].join("|");
}

function pushUnique(values: string[], value: unknown): void {
  if (typeof value === "string" && value.trim() && !values.includes(value)) values.push(value);
}

function finalPathSegment(url: string): string | undefined {
  const path = url.split(/[?#]/)[0] ?? "";
  const segment = path.replace(/\/+$/, "").split("/").pop();
  return segment || undefined;
}

export function externalLinkId(site: string, url: string): [AnimeIdProvider, string] | null {
  const normalized = site.toLowerCase().replace(/[_ -]/g, "");
  if (normalized.includes("anidb")) {
    const aid = url.split(/[?&]/).find((part) => part.startsWith("aid="));
    if (aid) return ["anidb", aid.slice(4)];
  }
  const id = finalPathSegment(url);
  if (!id) return null;
  if (normalized.includes("imdb")) return ["imdb", id];
  if (normalized.includes("anidb")) return ["anidb", id];
  if (normalized.includes("kitsu")) return ["kitsu", id];
  if (normalized.includes("anilist")) return ["anilist", id];
  if (normalized.includes("myanimelist") || normalized === "mal") return ["mal", id];
  if (normalized.includes("animeplanet")) return ["animePlanet", id];
  if (normalized.includes("livechart")) return ["liveChart", id];
  if (normalized.includes("themoviedb") || normalized === "tmdb") return ["tmdb", id];
  if (normalized.includes("thetvdb") || normalized === "tvdb") return ["tvdb", id];
  if (normalized.includes("animenewsnetwork")) return ["animeNewsNetwork", id];
  if (normalized.includes("anisearch")) return ["aniSearch", id];
  return null;
}

const KITSU_MAPPING_PROVIDERS: Record<string, AnimeIdProvider> = {
  "myanimelist/anime": "mal",
  "anilist/anime": "anilist",
  anidb: "anidb",
  imdb: "imdb",
  "imdb/title": "imdb",
  "thetvdb/series": "tvdb",
  thetvdb: "tvdb",
  "thetvdb/season": "tvdbSeason",
  "themoviedb/tv": "tmdb",
  "themoviedb/movie": "tmdb",
  themoviedb: "tmdb",
  "themoviedb/season": "tmdbSeason",
  "anime-planet/anime": "animePlanet",
  "anime-planet": "animePlanet",
  livechart: "liveChart",
  "livechart/me": "liveChart",
  animenewsnetwork: "animeNewsNetwork",
  "animenewsnetwork/encyclopedia": "animeNewsNetwork",
  anisearch: "aniSearch",
  simkl: "simkl",
  animecountdown: "animeCountdown",
};

export function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function formatMatches(expected: string | null | undefined, actual: unknown): boolean {
  return !expected || typeof actual !== "string" || normalizeTitle(expected) === normalizeTitle(actual);
}

function addSource(identity: AnimeIdentity, source: string): void {
  pushUnique(identity.mappingSources, source);
}

function addWarning(identity: AnimeIdentity, warning: string): void {
  pushUnique(identity.mappingWarnings, negativeMessage(warning));
}

function mergeExternalLinks(identity: AnimeIdentity, links: unknown, siteKey: string): void {
  for (const value of list(links)) {
    const link = record(value);
    const site = link?.[siteKey];
    const url = link?.url;
    if (typeof site !== "string" || typeof url !== "string") continue;
    const match = externalLinkId(site, url);
    if (match) setId(identity.ids, match[0], match[1]);
  }
}

export function mergeJikan(identity: AnimeIdentity, response: unknown): void {
  const payload = record(record(response)?.data);
  if (!payload) return;
  const malId = integer(payload.mal_id);
  if (malId !== undefined) setId(identity.ids, "mal", String(malId));
  for (const key of ["title", "title_english", "title_japanese"]) pushUnique(identity.titles, payload[key]);
  for (const title of list(payload.title_synonyms)) pushUnique(identity.titles, title);
  identity.year ??= integer(payload.year) ?? null;
  identity.format ??= text(payload.type) ?? null;
  identity.episodes ??= integer(payload.episodes) ?? null;
  mergeExternalLinks(identity, payload.external, "name");
  addSource(identity, "jikan");
}

export function anilistMediaTitles(media: Record<string, unknown>): string[] {
  const titles: string[] = [];
  const title = record(media.title);
  pushUnique(titles, title?.romaji);
  pushUnique(titles, title?.english);
  pushUnique(titles, title?.native);
  for (const synonym of list(media.synonyms)) pushUnique(titles, synonym);
  return titles;
}

export function mergeAniList(identity: AnimeIdentity, media: Record<string, unknown>, source: string): void {
  const id = integer(media.id);
  if (id !== undefined) setId(identity.ids, "anilist", String(id));
  const malId = integer(media.idMal);
  if (malId !== undefined) setId(identity.ids, "mal", String(malId));
  for (const title of anilistMediaTitles(media)) pushUnique(identity.titles, title);
  identity.year ??= integer(media.seasonYear) ?? integer(record(media.startDate)?.year) ?? null;
  identity.season ??= text(media.season) ?? null;
  identity.format ??= text(media.format) ?? null;
  identity.episodes ??= integer(media.episodes) ?? null;
  addSource(identity, source);
  mergeExternalLinks(identity, media.externalLinks, "site");
}

export function mergeAnikoto(identity: AnimeIdentity, anikotoId: string, anime: Record<string, unknown>): void {
  setId(identity.ids, "anikoto", anikotoId);
  for (const key of ["title", "alternative", "titles", "native"]) pushUnique(identity.titles, anime[key]);
  identity.year ??= integer(anime.year) ?? null;
  identity.season ??= text(anime.season) ?? null;
  const episodes = idValue(anime.episodes);
  identity.episodes ??= episodes && /^\d+$/.test(episodes) ? Number(episodes) : null;
  if (identity.format === null) {
    const type = list(record(anime.terms_by_type)?.type)[0];
    identity.format = typeof type === "string" ? type : null;
  }
  setId(identity.ids, "mal", idValue(anime.mal_id));
  setId(identity.ids, "anilist", idValue(anime.ani_id));
  addSource(identity, "anikoto");
}

function kitsuTitles(resource: Record<string, unknown>): string[] {
  const attributes = record(resource.attributes);
  const titles: string[] = [];
  pushUnique(titles, attributes?.canonicalTitle);
  for (const title of Object.values(record(attributes?.titles) ?? {})) pushUnique(titles, title);
  return titles;
}

function kitsuYear(attributes: Record<string, unknown> | null): number | undefined {
  const date = typeof attributes?.startDate === "string" ? attributes.startDate.slice(0, 4) : "";
  return /^\d{4}$/.test(date) ? Number(date) : undefined;
}

export function mergeKitsu(identity: AnimeIdentity, anime: Record<string, unknown>, mappings: unknown[]): void {
  if (typeof anime.id === "string") setId(identity.ids, "kitsu", anime.id);
  const attributes = record(anime.attributes);
  if (attributes) {
    for (const title of kitsuTitles(anime)) pushUnique(identity.titles, title);
    identity.year ??= kitsuYear(attributes) ?? null;
    identity.format ??= text(attributes.subtype) ?? null;
    identity.episodes ??= integer(attributes.episodeCount) ?? null;
  }
  for (const value of mappings) {
    const mapping = record(record(value)?.attributes);
    const site = typeof mapping?.externalSite === "string" ? mapping.externalSite.toLowerCase() : "";
    const provider = KITSU_MAPPING_PROVIDERS[site];
    if (provider && typeof mapping?.externalId === "string") setId(identity.ids, provider, mapping.externalId);
  }
  addSource(identity, "kitsu");
}

function kitsuSites(ids: AnimeIds): Array<[string, string]> {
  const sites: Array<[string, string]> = [];
  const add = (site: string, id: string | undefined) => {
    if (id) sites.push([site, id]);
  };
  add("anilist/anime", ids.anilist);
  add("myanimelist/anime", ids.mal);
  add("anidb", ids.anidb);
  add("imdb", ids.imdb);
  add("thetvdb/series", ids.tvdb);
  add("thetvdb/season", ids.tvdbSeason);
  add("themoviedb/tv", ids.tmdb);
  add("themoviedb/movie", ids.tmdb);
  add("themoviedb/season", ids.tmdbSeason);
  add("anime-planet/anime", ids.animePlanet);
  add("livechart", ids.liveChart);
  add("anisearch", ids.aniSearch);
  add("animenewsnetwork", ids.animeNewsNetwork);
  return sites;
}

const ANILIST_IDENTITY_FIELDS =
  "id idMal title { romaji english native } synonyms format season seasonYear episodes startDate { year } externalLinks { site url }";

export function createIdentityResolver(fetchImpl: FetchLike, sources: AnimeSources) {
  const identityJson = (url: string) =>
    getJson(fetchImpl, url, { headers: { "user-agent": IDENTITY_USER_AGENT }, timeoutMs: 10_000 }).catch(
      () => null,
    );

  const anilist = (query: string, variables: Record<string, unknown>) =>
    sources.anilistQuery(query, variables, { userAgent: IDENTITY_USER_AGENT, attempts: 3 });

  const fetchAniList = async (id: string) => {
    if (!/^\d+$/.test(id)) return null;
    const data = await anilist(`query($id:Int) { Media(id:$id, type:ANIME) { ${ANILIST_IDENTITY_FIELDS} } }`, {
      id: Number(id),
    });
    return record(data?.Media);
  };

  const searchAniList = async (title: string) => {
    const data = await anilist(
      `query($search:String) { Page(perPage:10) { media(search:$search, type:ANIME) { ${ANILIST_IDENTITY_FIELDS} } } }`,
      { search: title },
    );
    return list(record(data?.Page)?.media).map(record).filter((media) => media !== null);
  };

  const kitsuMappings = async (kitsuId: string) => {
    const payload = record(await identityJson(`${KITSU_BASE}/anime/${encodeURIComponent(kitsuId)}/mappings`));
    return Array.isArray(payload?.data) ? payload.data : null;
  };

  const kitsuForIds = async (ids: AnimeIds): Promise<[Record<string, unknown>, unknown[]] | null> => {
    if (ids.kitsu) {
      const mappings = await kitsuMappings(ids.kitsu);
      if (!mappings) return null;
      const anime = record(record(await identityJson(`${KITSU_BASE}/anime/${encodeURIComponent(ids.kitsu)}`))?.data);
      return [anime ?? { id: ids.kitsu }, mappings];
    }
    for (const [site, externalId] of kitsuSites(ids)) {
      const query = new URLSearchParams({ "filter[external_site]": site, "filter[external_id]": externalId });
      const mapping = record(list(record(await identityJson(`${KITSU_BASE}/mappings?${query}`))?.data)[0]);
      if (typeof mapping?.id !== "string" && typeof mapping?.id !== "number") continue;
      const anime = record(record(await identityJson(`${KITSU_BASE}/mappings/${mapping.id}/item`))?.data);
      if (!anime || typeof anime.id !== "string") continue;
      const mappings = await kitsuMappings(anime.id);
      if (mappings) return [anime, mappings];
    }
    return null;
  };

  const resolveTitle = async (
    identity: AnimeIdentity,
    title: string,
    year: number | null | undefined,
    format: string | null | undefined,
  ): Promise<boolean> => {
    const requested = normalizeTitle(title);
    if (!requested) return false;
    const matches = (await searchAniList(title)).filter((media) => {
      if (!anilistMediaTitles(media).some((candidate) => normalizeTitle(candidate) === requested)) return false;
      const seasonYear = integer(media.seasonYear);
      if (year && seasonYear !== undefined && seasonYear !== year) return false;
      return formatMatches(format, media.format);
    });
    if (matches.length === 1) {
      mergeAniList(identity, matches[0]!, "anilist-title-search");
      return true;
    }
    const search = new URLSearchParams({ "filter[text]": title, "page[limit]": "20" });
    const kitsuMatches = list(record(await identityJson(`${KITSU_BASE}/anime?${search}`))?.data)
      .map(record)
      .filter((resource): resource is Record<string, unknown> => {
        const attributes = record(resource?.attributes);
        if (!resource || !attributes) return false;
        if (!kitsuTitles(resource).some((candidate) => normalizeTitle(candidate) === requested)) return false;
        const startYear = kitsuYear(attributes);
        if (year && startYear !== undefined && startYear !== year) return false;
        return formatMatches(format, attributes.subtype);
      });
    if (kitsuMatches.length !== 1) return false;
    const kitsu = kitsuMatches[0]!;
    const mappings = typeof kitsu.id === "string" ? ((await kitsuMappings(kitsu.id)) ?? []) : [];
    mergeKitsu(identity, kitsu, mappings);
    return true;
  };

  return async function resolveIdentity(request: IdentityRequest): Promise<AnimeIdentity | null> {
    const ids = normalizedIds(request);
    const hadInputIdentifier = Object.keys(ids).length > 0;
    const identity: AnimeIdentity = {
      ids: { ...ids },
      titles: request.title !== undefined ? [request.title] : [],
      year: request.year ?? null,
      season: request.season ?? null,
      format: request.format ?? null,
      episodes: null,
      mappingConfidence: null,
      mappingSources: [],
      mappingWarnings: [],
    };
    let hadDirectMetadata = false;
    let matchedTitle = false;
    const anikotoId = identity.ids.anikoto;
    const anilistId = identity.ids.anilist;
    const malId = identity.ids.mal;
    const [anikoto, anilistMedia, malPayload] = await Promise.all([
      anikotoId
        ? identityJson(`https://anikotoapi.site/series/${encodeURIComponent(anikotoId)}`).then((payload) =>
            record(record(record(payload)?.data)?.anime),
          )
        : undefined,
      anilistId ? fetchAniList(anilistId) : undefined,
      malId ? (/^\d+$/.test(malId) ? sources.fetchAnime(Number(malId)) : Promise.resolve(null)) : undefined,
    ]);
    if (anikotoId) {
      if (anikoto) {
        mergeAnikoto(identity, anikotoId, anikoto);
        hadDirectMetadata = true;
      } else addWarning(identity, "anime metadata lookup failed");
    }
    if (anilistId) {
      if (anilistMedia) {
        mergeAniList(identity, anilistMedia, "anilist");
        hadDirectMetadata = true;
      } else addWarning(identity, "anime metadata lookup failed");
    }
    if (malId) {
      if (malPayload) {
        mergeJikan(identity, malPayload);
        hadDirectMetadata = true;
      } else addWarning(identity, "anime metadata lookup failed");
    }
    if (!identity.ids.anilist && !identity.ids.mal) {
      if (request.title !== undefined) {
        if (await resolveTitle(identity, request.title, request.year, request.format)) {
          matchedTitle = true;
          identity.mappingConfidence = "title";
        } else addWarning(identity, "title did not identify one exact anime entry");
      }
    } else if (!identity.ids.anilist && identity.titles.length > 0) {
      await resolveTitle(identity, identity.titles[0]!, identity.year, identity.format);
    }
    const kitsu = await kitsuForIds(identity.ids);
    if (kitsu) {
      mergeKitsu(identity, kitsu[0], kitsu[1]);
      identity.mappingConfidence = "mapped";
    }
    identity.mappingConfidence ??=
      hadDirectMetadata || hadInputIdentifier || identity.mappingSources.length > 0 ? "direct" : "mapped";
    const hasIdentifier = (
      ["anilist", "mal", "kitsu", "anidb", "tmdb", "imdb", "tvdb", "anikoto", "anikotoEpisode"] as const
    ).some((provider) => identity.ids[provider] !== undefined);
    return hasIdentifier || hadInputIdentifier || matchedTitle ? identity : null;
  };
}
