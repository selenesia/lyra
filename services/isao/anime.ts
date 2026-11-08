import { LoadFailure, TtlCache, jsonWeight, requestSlot } from "./cache.ts";
import {
  type FetchLike,
  getJson,
  integer,
  list,
  record,
  requestJson,
  text,
} from "./upstream.ts";

const JIKAN_BASE = "https://api.jikan.moe/v4";
const ANILIST_URL = "https://graphql.anilist.co";

export interface AnimeEpisode {
  mal_id: number;
  number: number;
  title: string | null;
}

export interface AnimeRelation {
  mal_id: number;
  name: string;
  relation: string;
  format: string | null;
  year: number | null;
  episode_count: number | null;
  source: string | null;
}

export interface AnimeSources {
  fetchAnime(malId: number): Promise<Record<string, unknown> | null>;
  jikanEpisodeCount(malId: number): Promise<number>;
  jikanEpisodes(malId: number): Promise<AnimeEpisode[] | null>;
  jikanRelations(malId: number): Promise<AnimeRelation[] | null>;
  anilistEpisodeCount(malId: number): Promise<number | null>;
  anilistAltTitles(anilistId: number): Promise<string[]>;
  anilistRelations(malId: number): Promise<AnimeRelation[] | null>;
  anilistQuery(
    query: string,
    variables: Record<string, unknown>,
    options?: { userAgent?: string; attempts?: number },
  ): Promise<Record<string, unknown> | null>;
  waitForAniList(): Promise<void>;
}

export function relationsFromJikan(payload: unknown, malId: number): AnimeRelation[] | null {
  const anime = record(payload);
  if (!anime || integer(anime.mal_id) !== malId) return null;
  const name = text(anime.title);
  const groups = Array.isArray(anime.relations) ? anime.relations : null;
  if (!name || !groups) return null;
  const aired = record(record(record(anime.aired)?.prop)?.from);
  const episodes = integer(anime.episodes);
  const relations: AnimeRelation[] = [
    {
      mal_id: malId,
      name,
      relation: "Self",
      format: text(anime.type) ?? null,
      year: integer(aired?.year) ?? null,
      episode_count: episodes && episodes > 0 ? episodes : null,
      source: "jikan",
    },
  ];
  for (const value of groups) {
    const group = record(value);
    const relation = typeof group?.relation === "string" ? group.relation : "";
    if (relation !== "Sequel" && relation !== "Prequel") continue;
    for (const item of list(group?.entry)) {
      const entry = record(item);
      const id = integer(entry?.mal_id);
      if (!entry || id === undefined || typeof entry.name !== "string" || entry.type !== "anime") continue;
      relations.push({
        mal_id: id,
        name: entry.name,
        relation,
        format: null,
        year: null,
        episode_count: null,
        source: null,
      });
    }
  }
  const order = (relation: string) => (relation === "Prequel" ? 0 : relation === "Self" ? 1 : 2);
  return relations
    .map((relation, index) => ({ relation, index }))
    .sort((left, right) => order(left.relation.relation) - order(right.relation.relation) || left.index - right.index)
    .map(({ relation }) => relation);
}

function anilistTitles(media: Record<string, unknown>): string[] {
  const title = record(media.title);
  const titles = [title?.romaji, title?.english, title?.native, ...list(media.synonyms)]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(titles)];
}

function anilistRelation(media: Record<string, unknown>, relation: string): AnimeRelation | null {
  const malId = integer(media.idMal);
  const title = record(media.title);
  const name = [title?.romaji, title?.english, title?.native].find(
    (value): value is string => typeof value === "string",
  );
  if (malId === undefined || !name) return null;
  const episodes = integer(media.episodes);
  return {
    mal_id: malId,
    name,
    relation,
    format: typeof media.format === "string" ? media.format : null,
    year: integer(record(media.startDate)?.year) ?? null,
    episode_count: episodes && episodes > 0 ? episodes : null,
    source: "anilist",
  };
}

export function relationsFromAniList(payload: unknown, malId: number): AnimeRelation[] | null {
  const media = record(payload);
  if (!media || integer(media.idMal) !== malId) return null;
  const self = anilistRelation(media, "Self");
  const edges = record(media.relations)?.edges;
  if (!self || !Array.isArray(edges)) return null;
  const relations = [self];
  for (const value of edges) {
    const edge = record(value);
    const node = record(edge?.node);
    const relationType = typeof edge?.relationType === "string" ? edge.relationType : "";
    if (!node || (relationType !== "PREQUEL" && relationType !== "SEQUEL") || node.type !== "ANIME") continue;
    const relation = anilistRelation(node, relationType);
    if (relation) relations.push(relation);
  }
  return relations;
}

export function anilistEpisodeCount(payload: unknown, malId: number): number | null {
  const media = record(payload);
  if (!media || integer(media.idMal) !== malId) return null;
  const episodes = integer(media.episodes);
  if (episodes && episodes > 0) return episodes;
  const airing = integer(record(media.nextAiringEpisode)?.episode);
  return airing && airing - 1 > 0 ? airing - 1 : null;
}

export function createAnimeSources(fetchImpl: FetchLike): AnimeSources {
  const jikanSlot = requestSlot(1_000);
  const anilistSlot = requestSlot(2_000);
  const animeCache = new TtlCache<number, Record<string, unknown>>({
    ttlMs: 10 * 60_000,
    maxWeight: 16 * 1024 * 1024,
    weigh: jsonWeight,
  });

  const jikan = async (path: string) => {
    await jikanSlot();
    return getJson(fetchImpl, `${JIKAN_BASE}${path}`, {
      headers: { "user-agent": "Mozilla/5.0" },
      timeoutMs: 10_000,
    });
  };

  const fetchAnime = (malId: number) =>
    animeCache
      .load(malId, async () => {
        const payload = record(await jikan(`/anime/${malId}/full`));
        if (integer(record(payload?.data)?.mal_id) !== malId) throw new LoadFailure("mismatch");
        return payload!;
      })
      .catch(() => null);

  const anilistQuery = async (
    query: string,
    variables: Record<string, unknown>,
    { userAgent, attempts = 1 }: { userAgent?: string; attempts?: number } = {},
  ): Promise<Record<string, unknown> | null> => {
    await anilistSlot();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await requestJson(fetchImpl, ANILIST_URL, {
        method: "POST",
        body: { query, variables },
        headers: userAgent ? { "user-agent": userAgent } : {},
        timeoutMs: 10_000,
      }).catch(() => null);
      if (!result) return null;
      if (result.status === 429 || result.status >= 500) {
        if (attempt + 1 < attempts) await Bun.sleep(500 * (attempt + 1));
        continue;
      }
      if (result.status < 200 || result.status >= 300) return null;
      const payload = record(result.body);
      if (list(payload?.errors).length > 0) return null;
      return record(payload?.data);
    }
    return null;
  };

  return {
    fetchAnime,
    waitForAniList: anilistSlot,
    anilistQuery,
    async jikanEpisodeCount(malId) {
      const count = integer(record((await fetchAnime(malId))?.data)?.episodes);
      return count && count > 0 ? count : 0;
    },
    async jikanEpisodes(malId) {
      const episodes: AnimeEpisode[] = [];
      let page = 1;
      let hasNext = true;
      while (hasNext && episodes.length < 2000) {
        const payload = record(await jikan(`/anime/${malId}/episodes?page=${page}`).catch(() => null));
        if (!payload || !Array.isArray(payload.data)) return null;
        if (payload.data.length === 0) break;
        for (const item of payload.data) {
          const episode = record(item);
          const id = integer(episode?.mal_id);
          if (id === undefined) return null;
          episodes.push({ mal_id: id, number: id, title: typeof episode?.title === "string" ? episode.title : null });
        }
        hasNext = record(payload.pagination)?.has_next_page === true;
        page += 1;
      }
      return hasNext ? null : episodes;
    },
    async jikanRelations(malId) {
      const payload = await fetchAnime(malId);
      return payload ? relationsFromJikan(payload.data, malId) : null;
    },
    async anilistEpisodeCount(malId) {
      const data = await anilistQuery(
        "query($id: Int) { Media(idMal: $id, type: ANIME) { idMal episodes nextAiringEpisode { episode } } }",
        { id: malId },
      );
      return anilistEpisodeCount(data?.Media, malId);
    },
    async anilistAltTitles(anilistId) {
      const data = await anilistQuery(
        "query($id:Int) { Media(id:$id) { title { romaji english native } synonyms } }",
        { id: anilistId },
      );
      const media = record(data?.Media);
      return media ? anilistTitles(media) : [];
    },
    async anilistRelations(malId) {
      const data = await anilistQuery(
        `query($id: Int) {
          Media(idMal: $id, type: ANIME) {
            idMal type title { romaji english native } format episodes startDate { year }
            relations { edges { relationType node {
              idMal type title { romaji english native } format episodes startDate { year }
            } } }
          }
        }`,
        { id: malId },
      );
      return relationsFromAniList(data?.Media, malId);
    },
  };
}
