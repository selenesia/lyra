import { useState, useEffect, useRef, useCallback, useMemo } from "preact/hooks";
import { useSlidingPill } from "../../hooks/useSlidingPill.ts";
import {
  buildAnimePlaybackUrl,
  fetchAnimeData,
  isAnimeMovieFormat,
  mergeAnimeEntries,
  resetAnimeCache,
  searchAnime,
  searchAnimeLocally,
  type AnimeEntry,
} from "../../features/anime/anime.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { readAnimeLanguage } from "../../core/media/animeSettings.ts";
import {
  ANIME_PROGRESS_EVENT,
  ANIME_PROGRESS_KEY,
  animeProgressLabel,
  animeResumeUrl,
  findAnimeProgress,
  readAnimeProgress,
  type AnimeProgress,
} from "../../features/anime/animeProgress.ts";
import {
  mergeAnimeIds,
  normalizeAnimeIds,
  resolveAnimeIdentity,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";
import {
  discoverTitles,
  fetchTitleHome,
  searchTitles,
  type TitleCard,
  type TitleType,
} from "../../features/watch/titles.ts";
import { buildTitlePlaybackUrl } from "../../features/watch/watchPlayback.ts";
import {
  WATCH_PROGRESS_EVENT,
  WATCH_PROGRESS_KEY,
  findWatchProgress,
  readWatchProgress,
  watchProgressDetail,
  watchProgressLabel,
  watchResumeUrl,
  type WatchProgress,
} from "../../features/watch/watchProgress.ts";
import {
  catalogMatchRank,
  normalizeCatalogText,
} from "../../core/media/catalogSearch.ts";
import { watchViewSignal } from "../../core/ui/uiSignals.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { app } from "../../core/runtime/app.ts";
import { useDebouncedValue } from "../../hooks/useDebouncedValue.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import CatalogView from "../catalog/CatalogView.tsx";
import EpisodePickerModal from "../anime/EpisodePickerModal.tsx";
import TitleEpisodePicker from "./TitleEpisodePicker.tsx";
import WatchResumeCard from "./WatchResumeCard.tsx";
import "../../assets/styles/watch/watch.css";

const SVG_WATCH = svgIcon("IconVideoClip", { size: 22, solid: true });
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");
const SEARCH_DEBOUNCE_MS = 120;
const TITLE_SEARCH_DEBOUNCE_MS = 350;

type WatchSection = "all" | "movies" | "shows" | "anime";
type WatchItem =
  | { kind: "anime"; key: string; anime: AnimeEntry }
  | { kind: "title"; key: string; title: TitleCard };
type ResumeEntry =
  | { kind: "anime"; progress: AnimeProgress }
  | { kind: "title"; progress: WatchProgress };

const SECTIONS: ReadonlyArray<{ id: WatchSection; label: string }> = [
  { id: "all", label: "all" },
  { id: "movies", label: "movies" },
  { id: "shows", label: "shows" },
  { id: "anime", label: "anime" },
];

const PLACEHOLDERS: Record<WatchSection, string> = {
  all: "search movies, shows, and anime... ◝(ᵔᗜᵔ)◜",
  movies: "search for any movie... ◝(ᵔᗜᵔ)◜",
  shows: "search for any show... ◝(ᵔᗜᵔ)◜",
  anime: "search for any anime... ◝(ᵔᗜᵔ)◜",
};

const SECTION_TYPES: Record<WatchSection, TitleType[]> = {
  all: ["movie", "tv"],
  movies: ["movie"],
  shows: ["tv"],
  anime: [],
};

function animeItem(anime: AnimeEntry): WatchItem {
  return { kind: "anime", key: `anime:${anime.id}`, anime };
}

function titleItem(title: TitleCard): WatchItem {
  return { kind: "title", key: `${title.type}:${title.id}`, title };
}

function interleave<T>(...lists: T[][]): T[] {
  const result: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const item = list[index];
      if (item !== undefined) result.push(item);
    }
  }
  return result;
}

function uniqueTitles(...lists: TitleCard[][]): TitleCard[] {
  const seen = new Set<string>();
  const result: TitleCard[] = [];
  for (const title of lists.flat()) {
    const key = `${title.type}:${title.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(title);
  }
  return result;
}

async function loadTitleFeed(type: TitleType): Promise<TitleCard[]> {
  const [home, trending, popular, rated] = await Promise.allSettled([
    fetchTitleHome(),
    discoverTitles(type, "trending"),
    discoverTitles(type, "popular"),
    discoverTitles(type, "top_rated"),
  ]);
  const results = (value: PromiseSettledResult<{ results: TitleCard[] }>) =>
    value.status === "fulfilled" ? value.value.results : [];
  const rails = home.status === "fulfilled"
    ? home.value.filter((rail) => rail.type === type).flatMap((rail) => rail.results)
    : [];
  const titles = uniqueTitles(results(trending), rails, results(popular), results(rated));
  if (titles.length === 0) throw new Error("watch feed unavailable... /ᐠ - ˕ -マ");
  return titles;
}

function rankItems(items: WatchItem[], query: string): WatchItem[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return items;
  const tokens = normalizedQuery.split(" ");
  return items
    .map((item, index) => {
      const title = item.kind === "anime" ? item.anime.title : item.title.title;
      const normalized = item.kind === "anime"
        ? item.anime._normalizedTitle ?? normalizeCatalogText(title)
        : normalizeCatalogText(title);
      const searchText = item.kind === "anime" ? item.anime._searchText || normalized : normalized;
      const rank = catalogMatchRank(normalized, searchText, normalizedQuery, tokens);
      return { item, index, rank: rank < 0 ? 5 : rank };
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

export default function WatchCatalog({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [section, setSection] = useState<WatchSection>("all");
  const [allAnime, setAllAnime] = useState<AnimeEntry[]>([]);
  const [animeLoaded, setAnimeLoaded] = useState(false);
  const [animeError, setAnimeError] = useState(false);
  const [titleFeed, setTitleFeed] = useState<Record<TitleType, TitleCard[]>>({ movie: [], tv: [] });
  const [titlesLoaded, setTitlesLoaded] = useState(false);
  const [titlesError, setTitlesError] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AnimeEntry[]>([]);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [titleResults, setTitleResults] = useState<{ query: string; movie: TitleCard[]; tv: TitleCard[] }>({
    query: "",
    movie: [],
    tv: [],
  });
  const [titleSearching, setTitleSearching] = useState(false);
  const [progress, setProgress] = useState<AnimeProgress[]>(readAnimeProgress);
  const [titleProgress, setTitleProgress] = useState<WatchProgress[]>(readWatchProgress);

  const [episodePickerVisible, setEpisodePickerVisible] = useState(false);
  const [episodePickerAnime, setEpisodePickerAnime] = useState<AnimeEntry | null>(null);
  const [episodePickerEpisode, setEpisodePickerEpisode] = useState(0);
  const [episodePickerLanguage, setEpisodePickerLanguage] = useState<"sub" | "dub">("sub");
  const [showPicker, setShowPicker] = useState<TitleCard | null>(null);
  const [showPickerVisible, setShowPickerVisible] = useState(false);
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const debouncedTitleQuery = useDebouncedValue(query.trim(), TITLE_SEARCH_DEBOUNCE_MS);
  const searchRequestIdRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const episodePickerRequestIdRef = useRef(0);
  const loadRequestIdRef = useRef(0);
  const loadPendingRef = useRef(false);
  const titlesPendingRef = useRef(false);

  const loadAnime = useCallback(() => {
    if (loadPendingRef.current) return;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    loadPendingRef.current = true;
    setAnimeError(false);
    fetchAnimeData("trending", (anime) => {
      if (loadRequestIdRef.current !== requestId) return;
      setAllAnime(anime);
    })
      .then((anime) => {
        if (loadRequestIdRef.current !== requestId) return;
        setAllAnime(anime);
        setAnimeLoaded(true);
      })
      .catch(() => {
        if (loadRequestIdRef.current !== requestId) return;
        setAnimeError(true);
        setAnimeLoaded(true);
      })
      .finally(() => {
        if (loadRequestIdRef.current === requestId) loadPendingRef.current = false;
      });
  }, []);

  const loadTitles = useCallback(() => {
    if (titlesPendingRef.current) return;
    titlesPendingRef.current = true;
    setTitlesError(false);
    void Promise.allSettled([loadTitleFeed("movie"), loadTitleFeed("tv")])
      .then(([movie, tv]) => {
        setTitleFeed({
          movie: movie.status === "fulfilled" ? movie.value : [],
          tv: tv.status === "fulfilled" ? tv.value : [],
        });
        setTitlesError(movie.status === "rejected" && tv.status === "rejected");
        setTitlesLoaded(true);
      })
      .finally(() => {
        titlesPendingRef.current = false;
      });
  }, []);

  const loadIfNeeded = useCallback(() => {
    if (!animeLoaded || allAnime.length === 0) loadAnime();
    if (!titlesLoaded || (titleFeed.movie.length === 0 && titleFeed.tv.length === 0)) loadTitles();
  }, [allAnime.length, animeLoaded, loadAnime, loadTitles, titleFeed, titlesLoaded]);

  const { visible, searchBarRef, show, hide, toggle } = useMenuView({
    bodyClass: "watch-view",
    signal: watchViewSignal,
    iconId: "watch-icon",
    inactiveIcon: SVG_WATCH,
    activeIcon: SVG_SEARCH,
    openedStorageKey: "lyraUserOpenedAnimeMenu",
    hideOtherViews: () => {
      window.hideGameMenu?.();
      window.hideChatPage?.();
    },
    onShowFrame: loadIfNeeded,
    showOnMount: openOnMount,
  });

  useEffect(() => {
    const refresh = () => {
      setProgress(readAnimeProgress());
      setTitleProgress(readWatchProgress());
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ANIME_PROGRESS_KEY || event.key === WATCH_PROGRESS_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    window.addEventListener(ANIME_PROGRESS_EVENT, refresh);
    window.addEventListener(WATCH_PROGRESS_EVENT, refresh);
    document.addEventListener("cloudsync-restored", refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(ANIME_PROGRESS_EVENT, refresh);
      window.removeEventListener(WATCH_PROGRESS_EVENT, refresh);
      document.removeEventListener("cloudsync-restored", refresh);
    };
  }, [visible]);

  const openPlayer = useCallback(
    (url: string, title: string, poster: string) => {
      episodePickerRequestIdRef.current += 1;
      setEpisodePickerVisible(false);
      setShowPickerVisible(false);
      hide();
      app().handleSearch?.(url, title, poster);
    },
    [hide],
  );

  const resumeAnime = useCallback(
    (saved: AnimeProgress) => openPlayer(animeResumeUrl(saved), saved.title, saved.posterUrl),
    [openPlayer],
  );

  const resumeTitle = useCallback(
    (saved: WatchProgress) => openPlayer(watchResumeUrl(saved), saved.title, saved.posterUrl),
    [openPlayer],
  );

  useEffect(() => {
    window.showWatchMenu = show;
    window.hideWatchMenu = hide;
    window.toggleWatchMenu = toggle;
    window.playNextEpisode = (request: {
      title: string;
      year?: number;
      anilistId?: number;
      malId?: number;
      ids?: AnimeIds;
      posterUrl: string;
      episodeCount?: number;
      format?: string;
      episode: number;
      language?: "sub" | "dub";
    }) => {
      show();
      setEpisodePickerEpisode(request.episode);
      setEpisodePickerLanguage(request.language ?? readAnimeLanguage());
      const ids = normalizeAnimeIds({
        ...request.ids,
        anilistId: request.anilistId,
        malId: request.malId,
      });
      setEpisodePickerAnime({
        id: ids.anilist || ids.mal || 0,
        title: request.title,
        year: request.year,
        posterUrl: request.posterUrl,
        anilistId: ids.anilist ? Number(ids.anilist) : undefined,
        malId: ids.mal ? Number(ids.mal) : undefined,
        ids,
        episodeCount: request.episodeCount,
        format: request.format,
        animeType: "anime",
      });
      setEpisodePickerVisible(true);
    };
    return () => {
      delete window.playNextEpisode;
    };
  }, [hide, show, toggle]);

  useEffect(() => {
    searchRequestIdRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) {
      searchRequestIdRef.current += 1;
      setSearching(false);
      setSearchResults([]);
      setSearchResultQuery("");
      return;
    }
    if (section !== "all" && section !== "anime") return;
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    searchAnime(debouncedQuery, controller.signal, (results) => {
      if (searchRequestIdRef.current !== requestId) return;
      setSearchResults(results);
      setSearchResultQuery(debouncedQuery.toLocaleLowerCase());
    })
      .then((results) => {
        if (searchRequestIdRef.current !== requestId) return;
        setSearchResults(results);
        setSearchResultQuery(debouncedQuery.toLocaleLowerCase());
        setSearching(false);
      })
      .catch(() => {
        if (controller.signal.aborted || searchRequestIdRef.current !== requestId) return;
        setSearching(false);
      });
    return () => {
      controller.abort();
      if (searchAbortRef.current === controller) searchAbortRef.current = null;
    };
  }, [debouncedQuery, section]);

  useEffect(() => {
    const types = SECTION_TYPES[section];
    const normalized = debouncedTitleQuery.toLocaleLowerCase();
    if (!debouncedTitleQuery || types.length === 0) {
      setTitleSearching(false);
      return;
    }
    if (titleResults.query === normalized && types.every((type) => titleResults[type].length > 0)) {
      setTitleSearching(false);
      return;
    }
    const controller = new AbortController();
    setTitleSearching(true);
    void Promise.allSettled(
      (["movie", "tv"] as const).map((type) =>
        types.includes(type) ? searchTitles(type, debouncedTitleQuery, 1, controller.signal) : null,
      ),
    ).then(([movie, tv]) => {
      if (controller.signal.aborted) return;
      setTitleResults((current) => {
        const keep = current.query === normalized;
        const pick = (value: PromiseSettledResult<{ results: TitleCard[] } | null> | undefined, previous: TitleCard[]) =>
          value?.status === "fulfilled" && value.value ? value.value.results : keep ? previous : [];
        return { query: normalized, movie: pick(movie, current.movie), tv: pick(tv, current.tv) };
      });
      setTitleSearching(false);
    });
    return () => controller.abort();
  }, [debouncedTitleQuery, section]);

  useEffect(() => {
    const handler = () => {
      resetAnimeCache();
      loadRequestIdRef.current += 1;
      loadPendingRef.current = false;
      searchRequestIdRef.current += 1;
      setAllAnime([]);
      setAnimeLoaded(false);
      setAnimeError(false);
      setQuery("");
      setSearchResults([]);
      setSearchResultQuery("");
      setSearching(false);
      loadAnime();
    };
    window.addEventListener("animeAdultChanged", handler);
    return () => {
      window.removeEventListener("animeAdultChanged", handler);
      loadRequestIdRef.current += 1;
      loadPendingRef.current = false;
    };
  }, [loadAnime]);

  const playAnime = useCallback(
    (anime: AnimeEntry) => {
      const saved = findAnimeProgress(progress, anime);
      const pickerRequestId = episodePickerRequestIdRef.current + 1;
      episodePickerRequestIdRef.current = pickerRequestId;
      const initialIds = normalizeAnimeIds({
        ...anime.ids,
        anilistId: anime.anilistId,
        malId: anime.malId,
      });
      const initialAnime = { ...anime, ids: initialIds };
      if (isAnimeMovieFormat(anime.format)) {
        if (saved) {
          resumeAnime(saved);
          return;
        }
        openPlayer(
          buildAnimePlaybackUrl({
            title: anime.title,
            posterUrl: anime.posterUrl,
            ids: initialIds,
            episode: 1,
            episodeCount: 1,
            language: readAnimeLanguage(),
            year: anime.year,
            format: anime.format,
          }),
          anime.title,
          anime.posterUrl,
        );
        return;
      }
      setEpisodePickerEpisode(0);
      setEpisodePickerLanguage(saved?.language ?? readAnimeLanguage());
      setEpisodePickerAnime(initialAnime);
      setEpisodePickerVisible(true);
      const isCurrentPicker = () => episodePickerRequestIdRef.current === pickerRequestId;
      void resolveAnimeIdentity({
        ids: initialIds,
        title: anime.title,
        year: anime.year,
        format: anime.format,
      }).then((identity) => {
        if (!identity || !isCurrentPicker()) return;
        setEpisodePickerAnime((current) => {
          if (!isCurrentPicker() || !current || current.id !== initialAnime.id) return current;
          const ids = mergeAnimeIds(current.ids, identity.ids);
          return {
            ...current,
            ids,
            anilistId: ids.anilist ? Number(ids.anilist) : current.anilistId,
            malId: ids.mal ? Number(ids.mal) : current.malId,
            episodeCount:
              current.episodeCount && current.episodeCount > 1
                ? current.episodeCount
                : identity.episodes || current.episodeCount,
            year: current.year || identity.year,
            format: current.format || identity.format,
          };
        });
      });
    },
    [progress, resumeAnime, openPlayer],
  );

  const playTitle = useCallback(
    (title: TitleCard) => {
      if (title.type === "tv") {
        setShowPicker(title);
        setShowPickerVisible(true);
        return;
      }
      const saved = findWatchProgress(titleProgress, title);
      if (saved) {
        resumeTitle(saved);
        return;
      }
      const poster = title.posterUrl || title.posterSmallUrl || "";
      openPlayer(
        buildTitlePlaybackUrl({ type: "movie", id: title.id, title: title.title, posterUrl: poster, year: title.year }),
        title.title,
        poster,
      );
    },
    [titleProgress, resumeTitle, openPlayer],
  );

  const handleSelect = useCallback(
    (item: WatchItem) => (item.kind === "anime" ? playAnime(item.anime) : playTitle(item.title)),
    [playAnime, playTitle],
  );

  const getCard = useCallback(
    (item: WatchItem) => {
      if (item.kind === "anime") {
        const saved = findAnimeProgress(progress, item.anime);
        return {
          title: item.anime.title,
          cover: item.anime.posterUrl,
          smallCover: item.anime.posterSmallUrl,
          year: item.anime.year,
          rating: item.anime.rating,
          adult: item.anime.adult,
          badge: section === "all" ? "anime" : undefined,
          resumeLabel: saved ? animeProgressLabel(saved, "watching") : undefined,
        };
      }
      const saved = findWatchProgress(titleProgress, item.title);
      return {
        title: item.title.title,
        cover: item.title.posterUrl,
        smallCover: item.title.posterSmallUrl,
        year: item.title.year,
        rating: item.title.rating,
        badge: section === "all" ? (item.title.type === "movie" ? "movie" : "show") : undefined,
        resumeLabel: saved ? watchProgressLabel(saved, "watching") : undefined,
      };
    },
    [progress, titleProgress, section],
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const localAnimeResults = useMemo(() => searchAnimeLocally(allAnime, query), [allAnime, query]);
  const animeItems = useMemo(() => {
    if (!normalizedQuery) return allAnime.map(animeItem);
    const remote = searchResultQuery === normalizedQuery ? searchResults : [];
    return mergeAnimeEntries(remote, localAnimeResults).map(animeItem);
  }, [allAnime, localAnimeResults, normalizedQuery, searchResultQuery, searchResults]);
  const titleItems = useMemo(() => {
    const pick = (type: TitleType) => {
      if (!normalizedQuery) return titleFeed[type];
      const remote = titleResults.query === normalizedQuery ? titleResults[type] : [];
      const tokens = normalizeCatalogText(query);
      const local = tokens
        ? titleFeed[type].filter((title) => normalizeCatalogText(title.title).includes(tokens))
        : [];
      return uniqueTitles(remote, local);
    };
    return { movie: pick("movie").map(titleItem), tv: pick("tv").map(titleItem) };
  }, [normalizedQuery, query, titleFeed, titleResults]);

  const items = useMemo(() => {
    if (section === "anime") return animeItems;
    if (section === "movies") return titleItems.movie;
    if (section === "shows") return titleItems.tv;
    const mixed = interleave(titleItems.movie, titleItems.tv, animeItems);
    return normalizedQuery ? rankItems(mixed, query) : mixed;
  }, [section, animeItems, titleItems, normalizedQuery, query]);

  const usesAnime = section === "all" || section === "anime";
  const usesTitles = section !== "anime";
  const isSearchActive = normalizedQuery.length > 0;
  const animeSearchPending =
    usesAnime && isSearchActive && (searching || debouncedQuery.toLocaleLowerCase() !== normalizedQuery);
  const titleSearchPending =
    usesTitles && isSearchActive && (titleSearching || debouncedTitleQuery.toLocaleLowerCase() !== normalizedQuery);
  const searchPending = animeSearchPending || titleSearchPending;
  const feedLoaded = (!usesAnime || animeLoaded) && (!usesTitles || titlesLoaded);
  const showSkeleton = (!isSearchActive && !feedLoaded && items.length === 0) || (searchPending && items.length === 0);
  const feedPending = !isSearchActive && !feedLoaded && items.length > 0;
  const feedError =
    (section === "anime" && animeError) ||
    ((section === "movies" || section === "shows") && titlesError) ||
    (section === "all" && animeError && titlesError);

  const resume = useMemo<ResumeEntry | null>(() => {
    const anime = usesAnime ? progress.find((saved) => !saved.completed) : undefined;
    const title = titleProgress.find(
      (saved) =>
        !saved.completed &&
        (section === "all" || (section === "movies" && saved.type === "movie") || (section === "shows" && saved.type === "tv")),
    );
    if (anime && (!title || anime.updatedAt >= title.updatedAt)) return { kind: "anime", progress: anime };
    return title ? { kind: "title", progress: title } : null;
  }, [progress, titleProgress, section, usesAnime]);

  const episodePickerProgress = episodePickerAnime ? findAnimeProgress(progress, episodePickerAnime) : undefined;
  const showPickerProgress = showPicker ? findWatchProgress(titleProgress, showPicker) : undefined;

  const setSectionsTrack = useSlidingPill('[aria-selected="true"]', section);

  const toolbar = (
    <div class="watch-sections" role="tablist" aria-label="watch sections" ref={setSectionsTrack}>
      <span class="watch-section-pill" aria-hidden="true" />
      {SECTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={section === option.id}
          class={`watch-section-tab${section === option.id ? " is-active" : ""}`}
          onClick={() => setSection(option.id)}
        >
          <span class="watch-section-chip" />
          <span class="watch-section-label">{option.label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      <CatalogView
        id="watch-page"
        className="watch-page"
        inputId="mediaSearchInput"
        visible={visible}
        searchBarRef={searchBarRef}
        query={query}
        placeholder={feedLoaded || items.length > 0 ? PLACEHOLDERS[section] : "fetching titles..."}
        onQueryChange={setQuery}
        showSkeleton={showSkeleton}
        items={items}
        getCard={getCard}
        onSelect={handleSelect}
        posters
        beforeGrid={
          <>
            {toolbar}
            {!isSearchActive && resume ? (
              resume.kind === "anime" ? (
              <WatchResumeCard
                title={resume.progress.title}
                posterUrl={resume.progress.posterUrl}
                caption={`${animeProgressLabel(resume.progress, "resume")} · ${resume.progress.language}`}
                onResume={() => resumeAnime(resume.progress)}
              />
            ) : (
              <WatchResumeCard
                title={resume.progress.title}
                posterUrl={resume.progress.posterUrl}
                caption={`${watchProgressLabel(resume.progress, "resume")} · ${watchProgressDetail(resume.progress)}`}
                onResume={() => resumeTitle(resume.progress)}
              />
              )
            ) : null}
          </>
        }
        emptyMessage={
          feedLoaded && !searchPending && items.length === 0
            ? feedError
              ? negativeMessage(section === "anime" ? "failed to fetch anime data" : "failed to fetch movies and shows")
              : negativeMessage("no matches were found")
            : null
        }
        statusMessage={searchPending ? "searching..." : feedPending ? "fetching more titles..." : null}
      />

      {episodePickerAnime && (
        <EpisodePickerModal
          key={`${episodePickerAnime.animeType}-${episodePickerAnime.id}`}
          visible={episodePickerVisible}
          title={episodePickerAnime.title}
          year={episodePickerAnime.year}
          type={episodePickerAnime.animeType}
          ids={episodePickerAnime.ids}
          anilistId={episodePickerAnime.anilistId}
          malId={episodePickerAnime.malId}
          posterUrl={episodePickerAnime.posterUrl}
          episodeCount={episodePickerAnime.episodeCount}
          format={episodePickerAnime.format}
          initialEpisode={episodePickerEpisode}
          initialLanguage={episodePickerLanguage}
          resume={
            episodePickerProgress
              ? {
                  label: `${animeProgressLabel(episodePickerProgress)} · ${episodePickerProgress.language}`,
                  onResume: () => resumeAnime(episodePickerProgress),
                }
              : undefined
          }
          onClose={() => setEpisodePickerVisible(false)}
          onPlay={openPlayer}
        />
      )}

      {showPicker && (
        <TitleEpisodePicker
          key={`tv-${showPicker.id}`}
          visible={showPickerVisible}
          id={showPicker.id}
          title={showPicker.title}
          posterUrl={showPicker.posterUrl || showPicker.posterSmallUrl || ""}
          year={showPicker.year}
          initialSeason={showPickerProgress?.season}
          currentSeason={showPickerProgress?.season}
          currentEpisode={showPickerProgress?.episode}
          language={showPickerProgress?.language}
          resume={
            showPickerProgress
              ? {
                  label: `${watchProgressLabel(showPickerProgress)} · ${watchProgressDetail(showPickerProgress)}`,
                  onResume: () => resumeTitle(showPickerProgress),
                }
              : undefined
          }
          onClose={() => setShowPickerVisible(false)}
          onPlay={openPlayer}
        />
      )}
    </>
  );
}
