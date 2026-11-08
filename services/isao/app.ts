import { negativeMessage } from "../../src/core/runtime/messages.ts";
import { type AnimeEpisode, type AnimeRelation, type AnimeSources, createAnimeSources } from "./anime.ts";
import { Gate, LoadFailure, TtlCache, hedgedCount, jsonWeight } from "./cache.ts";
import {
  type AnimeIdentity,
  type IdentityRequest,
  createIdentityResolver,
  identityCacheKey,
  normalizedIds,
  parseIdentityRequest,
} from "./identity.ts";
import { TitleRequestError, createTitleMetadata, parseTitleQuery } from "./titles.ts";
import { type FetchLike, integer, record } from "./upstream.ts";

const ANILIST_HEDGE_DELAY_MS = 1_500;
const MAX_BODY_BYTES = 64 * 1024;
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};
const METADATA_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=600";

interface EpisodeList {
  count: number;
  episodes: AnimeEpisode[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

function providerFailure(message: string, body: Record<string, unknown>): Response {
  return json({ ...body, error: negativeMessage(message) }, 502);
}

function invalidRequest(message: string): Response {
  return json({ error: negativeMessage(message) }, 422);
}

function positiveId(value: string | undefined | null): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new LoadFailure("too_large");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new LoadFailure("too_large");
  try {
    return JSON.parse(body);
  } catch {
    throw new LoadFailure("invalid_json");
  }
}

export interface IsaoOptions {
  fetch?: FetchLike;
  sources?: AnimeSources;
  upstreamLimit?: number;
  memoryMb?: number;
}

export function createIsao({ fetch: fetchImpl = fetch, sources, upstreamLimit, memoryMb = 512 }: IsaoOptions = {}) {
  const anime = sources ?? createAnimeSources(fetchImpl);
  const resolver = createIdentityResolver(fetchImpl, anime);
  const titles = createTitleMetadata(fetchImpl);
  const metadataEntries = Math.min(100_000, Math.max(2_000, memoryMb * 2));
  const gate = new Gate(upstreamLimit ?? Math.min(256, Math.max(4, navigator.hardwareConcurrency * 2)));
  const episodeLists = new TtlCache<number, EpisodeList>({
    ttlMs: 10 * 60_000,
    maxWeight: Math.min(64, Math.max(8, memoryMb / 256)) * 1024 * 1024,
    weigh: jsonWeight,
  });
  const episodeCounts = new TtlCache<number, number>({ ttlMs: 10 * 60_000, maxWeight: metadataEntries });
  const relations = new TtlCache<number, AnimeRelation[]>({ ttlMs: 30 * 60_000, maxWeight: metadataEntries / 4 });
  const altTitles = new TtlCache<number, string[]>({ ttlMs: 24 * 60 * 60_000, maxWeight: metadataEntries / 2 });
  const identities = new TtlCache<string, AnimeIdentity>({ ttlMs: 24 * 60 * 60_000, maxWeight: metadataEntries });
  const failures = new TtlCache<string, true>({ ttlMs: 15_000, maxWeight: metadataEntries });

  const guarded = async <T>(failureKey: string, task: () => Promise<T>): Promise<T | null> => {
    if (failures.has(failureKey)) return null;
    try {
      return await task();
    } catch {
      failures.set(failureKey, true);
      return null;
    }
  };

  const episodeCount = (malId: number): Promise<number> => {
    const cached = episodeCounts.get(malId);
    if (cached !== undefined) return Promise.resolve(cached);
    const selfCount = relations
      .get(malId)
      ?.find((relation) => relation.mal_id === malId && relation.relation === "Self")?.episode_count;
    if (selfCount && selfCount > 0) {
      episodeCounts.set(malId, selfCount);
      return Promise.resolve(selfCount);
    }
    return guarded(`episode-count:${malId}`, () =>
      episodeCounts.load(malId, () =>
        gate.run(2_000, async () => {
          const count = await hedgedCount(
            withDeadline(5_000, anime.jikanEpisodeCount(malId)),
            () => withDeadline(6_000, anime.anilistEpisodeCount(malId)).then((value) => value ?? 0),
            ANILIST_HEDGE_DELAY_MS,
          );
          if (count > 0) return count;
          const episodes = await withDeadline(6_000, anime.jikanEpisodes(malId));
          const highest = Math.max(0, ...(episodes ?? []).map((episode) => episode.number));
          if (highest <= 0) throw new LoadFailure("empty");
          return highest;
        }),
      ),
    ).then((count) => count ?? 0);
  };

  const episodesResponse = async (malId: number, countOnly: boolean): Promise<Response> => {
    if (countOnly) {
      const count = episodeLists.get(malId)?.count ?? (await episodeCount(malId));
      const payload = { count, episodes: [] };
      return count > 0 ? json(payload) : providerFailure("anime episode provider is temporarily unavailable", payload);
    }
    const cached = episodeLists.get(malId);
    if (cached) return json(cached);
    const list = await guarded(`episodes:${malId}`, () =>
      episodeLists.load(malId, () =>
        gate.run(10_000, async () => {
          const [episodes, count] = await Promise.all([anime.jikanEpisodes(malId), anime.jikanEpisodeCount(malId)]);
          if (count === 0 && !episodes?.length) throw new LoadFailure("empty");
          const items = episodes ?? [];
          return {
            count: count > 0 ? count : Math.max(0, ...items.map((episode) => episode.number)),
            episodes: items,
          };
        }),
      ),
    );
    return list
      ? json(list)
      : providerFailure("anime episode provider is temporarily unavailable", { count: 0, episodes: [] });
  };

  const relationsResponse = async (malId: number): Promise<Response> => {
    const cached = relations.get(malId);
    if (cached) return json({ relations: cached });
    const result = await guarded(`relations:${malId}`, () =>
      relations.load(malId, () =>
        gate.run(2_000, async () => {
          const found =
            (await withDeadline(5_000, anime.jikanRelations(malId)).catch(() => null)) ??
            (await withDeadline(6_000, anime.anilistRelations(malId)).catch(() => null));
          if (!found) throw new LoadFailure("empty");
          return found;
        }),
      ),
    );
    return result
      ? json({ relations: result })
      : providerFailure("anime relation provider is temporarily unavailable", { relations: [] });
  };

  const altTitlesResponse = async (anilistId: number): Promise<Response> => {
    const cached = altTitles.get(anilistId);
    if (cached) return json({ titles: cached });
    const result = await guarded(`titles:${anilistId}`, () =>
      altTitles.load(anilistId, () =>
        gate.run(10_000, async () => {
          const found = await anime.anilistAltTitles(anilistId);
          if (found.length === 0) throw new LoadFailure("empty");
          return found;
        }),
      ),
    );
    return result
      ? json({ titles: result })
      : providerFailure("anime title provider is temporarily unavailable", { titles: [] });
  };

  const resolveIdentity = (request: IdentityRequest): Promise<AnimeIdentity | null> => {
    const key = identityCacheKey(request);
    const cached = identities.get(key);
    if (cached) return Promise.resolve(cached);
    return guarded(`identity:${key}`, () =>
      identities.load(key, () =>
        gate.run(15_000, async () => {
          const identity = await resolver(request);
          if (!identity) throw new LoadFailure("unresolved");
          return identity;
        }),
      ),
    );
  };

  const identityEpisodesResponse = async (params: URLSearchParams): Promise<Response> => {
    const malId = positiveId(params.get("mal_id"));
    if (malId) return episodesResponse(malId, false);
    const anilistId = positiveId(params.get("anilist_id"));
    if (!anilistId) return json({ count: 0, episodes: [] });
    const identity = await resolveIdentity({
      ids: {},
      anilistId,
      malId: undefined,
      title: undefined,
      year: undefined,
      season: undefined,
      format: undefined,
    });
    if (!identity) return json({ count: 0, episodes: [] });
    const resolvedMal = positiveId(identity.ids.mal);
    if (!resolvedMal) return json({ count: identity.episodes ?? 0, episodes: [] });
    return episodesResponse(resolvedMal, false);
  };

  const resolveStreamResponse = (body: unknown): Response => {
    const request = parseIdentityRequest(body);
    const payload = record(body);
    if (!request || !payload) return invalidRequest("invalid stream request");
    const episode = integer(payload.episode);
    if (episode === undefined || typeof payload.episode !== "number") return invalidRequest("invalid stream request");
    if (payload.language !== undefined && payload.language !== null && typeof payload.language !== "string") {
      return invalidRequest("invalid stream request");
    }
    const language = (typeof payload.language === "string" ? payload.language : "sub").trim().toLowerCase();
    if (language !== "sub" && language !== "dub") return invalidRequest("language must be sub or dub");
    const ids = normalizedIds(request);
    const anilistId = positiveId(ids.anilist);
    const malId = positiveId(ids.mal);
    const anikotoEpisode = ids.anikotoEpisode;
    if ((episode <= 0 && !anikotoEpisode) || (!anilistId && !malId && !anikotoEpisode)) {
      return invalidRequest("an anime id and episode are required");
    }
    const query = new URLSearchParams();
    if (anilistId) query.set("anilist_id", String(anilistId));
    if (malId) query.set("mal_id", String(malId));
    if (anikotoEpisode) query.set("anikoto_episode_id", anikotoEpisode);
    if (episode > 0) query.set("episode", String(episode));
    query.set("language", language);
    return json({ source: "anikoto", status: "ready", mochi_url: `/stream/anikoto?${query}` });
  };

  const titleResponse = async (url: URL): Promise<Response> => {
    let query;
    try {
      query = parseTitleQuery(url.pathname, url.searchParams);
    } catch (error) {
      if (error instanceof TitleRequestError && error.code === "WATCH_ROUTE_NOT_FOUND") {
        return json({ error: negativeMessage("watch metadata route was not found"), code: error.code }, 404);
      }
      return json({ error: negativeMessage("invalid watch metadata request"), code: "WATCH_REQUEST_INVALID" }, 422);
    }
    try {
      const value = await gate.run(10_000, () => titles.load(query));
      return json(value, 200, { "cache-control": METADATA_CACHE_CONTROL });
    } catch (error) {
      if (error instanceof LoadFailure && (error.reason === "not_found" || error.reason === "mismatch")) {
        return json({ error: negativeMessage("this title was not found"), code: "WATCH_TITLE_NOT_FOUND" }, 404);
      }
      return json(
        { error: negativeMessage("movie and show metadata is temporarily unavailable"), code: "WATCH_METADATA_UNAVAILABLE" },
        502,
      );
    }
  };

  const metrics = () => ({
    upstream: gate.snapshot(),
    cache: {
      episodes: episodeLists.size,
      relations: relations.size,
      titles: altTitles.size,
      identity: identities.size,
      failures: failures.size,
      watch: titles.size,
      watch_failures: titles.failures(),
    },
  });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method === "GET" || request.method === "HEAD") {
      if (pathname === "/health") return new Response("oki", { headers: CORS_HEADERS });
      if (pathname === "/api/anime/metrics") return json(metrics());
      if (pathname === "/api/anime/episodes") return identityEpisodesResponse(url.searchParams);
      const route = /^\/api\/anime\/(episodes|relations|alttitles)\/([^/]+)$/.exec(pathname);
      if (route) {
        const id = positiveId(route[2]);
        if (!id) return invalidRequest("invalid anime id");
        if (route[1] === "episodes") {
          const countOnly = url.searchParams.get("count_only");
          if (countOnly !== null && countOnly !== "true" && countOnly !== "false") {
            return invalidRequest("invalid anime episode request");
          }
          return episodesResponse(id, countOnly === "true");
        }
        return route[1] === "relations" ? relationsResponse(id) : altTitlesResponse(id);
      }
      if (pathname.startsWith("/api/watch/")) return titleResponse(url);
    }
    if (request.method === "POST" && (pathname === "/api/anime/identity/resolve" || pathname === "/api/anime/resolve-stream")) {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        return invalidRequest(pathname.endsWith("resolve-stream") ? "invalid stream request" : "invalid identity request");
      }
      if (pathname.endsWith("resolve-stream")) return resolveStreamResponse(body);
      const identityRequest = parseIdentityRequest(body);
      if (!identityRequest) return invalidRequest("invalid identity request");
      const identity = await resolveIdentity(identityRequest);
      if (!identity) {
        return json(
          { error: negativeMessage("anime identity could not be resolved"), ids: normalizedIds(identityRequest) },
          404,
        );
      }
      return json(identity);
    }
    return json({ error: negativeMessage("route was not found") }, 404);
  }

  return { handle, metrics };
}

function withDeadline<T>(timeoutMs: number, task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LoadFailure("timeout")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
