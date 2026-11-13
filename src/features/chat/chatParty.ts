import { useEffect, useState } from "preact/hooks";
import { CHAT_PARTY_COMMAND, CHAT_PARTY_PATHS, readPartyMedia, type ChatPartyKind, type ChatPartyMedia } from "./chatProtocol.ts";

export interface ChatPartyTitle {
  key: string;
  title: string;
  poster?: string | undefined;
  detail: string;
  url: string;
}

interface PartyTitles {
  query: string | undefined;
  titles: ChatPartyTitle[];
  loading: boolean;
}

const CONTINUE_LIMIT = 5;
const SEARCH_LIMIT = 6;
const SEARCH_PER_SOURCE = 3;
const SEARCH_DELAY_MS = 300;
const NO_TITLES: PartyTitles = { query: undefined, titles: [], loading: false };
const KIND_LABELS: Record<ChatPartyKind, string> = { movie: "movie", tv: "show", anime: "anime" };

export function partyKindLabel(kind: ChatPartyKind): string {
  return KIND_LABELS[kind];
}

export function partyQuery(draft: string): string | undefined {
  return CHAT_PARTY_COMMAND.test(draft) ? draft.replace(CHAT_PARTY_COMMAND, "").trim() : undefined;
}

export function partyMediaOf(url: string): ChatPartyMedia | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  const path = (Object.keys(CHAT_PARTY_PATHS) as Array<keyof typeof CHAT_PARTY_PATHS>).find((key) =>
    parsed.pathname.endsWith(CHAT_PARTY_PATHS[key]),
  );
  return path ? readPartyMedia(path, parsed.search.slice(1)) : null;
}

function titleDetail(kind: ChatPartyKind, extra: string | undefined): string {
  return extra ? `${KIND_LABELS[kind]} · ${extra}` : KIND_LABELS[kind];
}

function interleave(groups: ChatPartyTitle[][], limit: number): ChatPartyTitle[] {
  const picked: ChatPartyTitle[] = [];
  for (let index = 0; picked.length < limit && groups.some((group) => index < group.length); index += 1) {
    for (const group of groups) {
      const title = group[index];
      if (title && picked.length < limit) picked.push(title);
    }
  }
  return picked;
}

async function continueTitles(): Promise<ChatPartyTitle[]> {
  const [watch, anime] = await Promise.all([import("../watch/watchProgress.ts"), import("../anime/animeProgress.ts")]);
  const titles = watch.readWatchProgress()
    .filter((progress) => !progress.completed)
    .map((progress) => ({
      at: progress.updatedAt,
      title: {
        key: `watch-${progress.type}-${progress.id}`,
        title: progress.title,
        poster: progress.posterUrl || undefined,
        detail: titleDetail(progress.type, progress.type === "tv" ? `s${progress.season ?? 1} e${progress.episode ?? 1}` : progress.year ? String(progress.year) : undefined),
        url: watch.watchResumeUrl(progress),
      },
    }));
  const shows = anime.readAnimeProgress()
    .filter((progress) => !progress.completed)
    .map((progress, index) => ({
      at: progress.updatedAt,
      title: {
        key: `anime-${progress.ids?.anilist ?? progress.ids?.mal ?? index}`,
        title: progress.title,
        poster: progress.posterUrl || undefined,
        detail: titleDetail("anime", `episode ${progress.episode}`),
        url: anime.animeResumeUrl(progress),
      },
    }));
  return [...titles, ...shows]
    .sort((left, right) => right.at - left.at)
    .slice(0, CONTINUE_LIMIT)
    .map((entry) => entry.title);
}

async function searchWatchTitles(type: "movie" | "tv", query: string, signal: AbortSignal): Promise<ChatPartyTitle[]> {
  const [{ searchTitles }, { buildTitlePlaybackUrl }, progress] = await Promise.all([
    import("../watch/titles.ts"),
    import("../watch/watchPlayback.ts"),
    import("../watch/watchProgress.ts"),
  ]);
  const page = await searchTitles(type, query, 1, signal);
  const records = progress.readWatchProgress();
  return page.results.slice(0, SEARCH_PER_SOURCE).map((card) => {
    const saved = progress.findWatchProgress(records, card);
    const season = saved?.season ?? 1;
    const episode = saved?.episode ?? 1;
    return {
      key: `${type}-${card.id}`,
      title: card.title,
      poster: card.posterSmallUrl ?? card.posterUrl,
      detail: titleDetail(type, type === "tv" ? `s${season} e${episode}` : card.year ? String(card.year) : undefined),
      url: saved
        ? progress.watchResumeUrl(saved)
        : buildTitlePlaybackUrl({ type, id: card.id, title: card.title, posterUrl: card.posterUrl ?? "", year: card.year }),
    };
  });
}

async function searchAnimeTitles(query: string, signal: AbortSignal): Promise<ChatPartyTitle[]> {
  const [{ buildAnimePlaybackUrl, searchAnime }, progress, { normalizeAnimeIds }, { readAnimeLanguage }] = await Promise.all([
    import("../anime/anime.ts"),
    import("../anime/animeProgress.ts"),
    import("../anime/animeIdentity.ts"),
    import("../../core/media/animeSettings.ts"),
  ]);
  const results = await searchAnime(query, signal);
  const records = progress.readAnimeProgress();
  return results.slice(0, SEARCH_PER_SOURCE).map((entry) => {
    const saved = progress.findAnimeProgress(records, entry);
    return {
      key: `anime-${entry.id}`,
      title: entry.title,
      poster: entry.posterSmallUrl ?? entry.posterUrl,
      detail: titleDetail("anime", `episode ${saved?.episode ?? 1}`),
      url: saved
        ? progress.animeResumeUrl(saved)
        : buildAnimePlaybackUrl({
            title: entry.title,
            posterUrl: entry.posterUrl,
            ids: normalizeAnimeIds({ ...entry.ids, anilistId: entry.anilistId, malId: entry.malId }),
            episode: 1,
            episodeCount: entry.episodeCount,
            language: readAnimeLanguage(),
            year: entry.year,
            format: entry.format,
          }),
    };
  });
}

export function usePartyTitles(query: string | undefined): PartyTitles {
  const [state, setState] = useState<PartyTitles>(NO_TITLES);

  useEffect(() => {
    if (query === undefined) {
      setState(NO_TITLES);
      return;
    }
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const sources = query
        ? [
            searchWatchTitles("movie", query, controller.signal),
            searchWatchTitles("tv", query, controller.signal),
            searchAnimeTitles(query, controller.signal),
          ]
        : [continueTitles()];
      const found: ChatPartyTitle[][] = sources.map(() => []);
      let waiting = sources.length;
      setState((current) => ({ query, titles: current.query === query ? current.titles : [], loading: true }));
      sources.forEach((source, index) => {
        void source
          .then(
            (titles) => {
              found[index] = titles;
            },
            () => undefined,
          )
          .finally(() => {
            waiting -= 1;
            if (!live) return;
            setState({ query, titles: interleave(found, query ? SEARCH_LIMIT : CONTINUE_LIMIT), loading: waiting > 0 });
          });
      });
    }, query ? SEARCH_DELAY_MS : 0);
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  if (query === undefined) return NO_TITLES;
  return state.query === query ? state : { query, titles: state.titles, loading: true };
}
