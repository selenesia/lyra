import { memo } from "preact/compat";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  buildAnimePlaybackUrl,
  chooseEpisodeCount,
  episodeNumbersForCount,
  fetchAnimeEpisodeCount,
  fetchAnikotoEpisodes,
  isAnimeMovieFormat,
  playableAnimeParts,
  type AnimeEpisodeMapping,
  type AnimeSeason,
} from "../../features/anime/anime.ts";
import {
  hasAnimeIdentity,
  normalizeAnimeIds,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";
import { useManagedModal } from "../../core/ui/modal.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { useVirtualGrid } from "../../hooks/useVirtualGrid.ts";
import "../../assets/styles/watch/episode-selector.css";
import "../../assets/styles/watch/episode-picker-modal.css";

const SVG_XMARK = svgIcon("IconCrossMedium");
const NO_EPISODES: AnimeEpisodeMapping[] = [];

interface EpisodePickerModalProps {
  visible: boolean;
  title: string;
  year?: number | undefined;
  type: "movie" | "tv" | "anime";
  ids?: AnimeIds | undefined;
  seasons?: AnimeSeason[] | undefined;
  seasonsLoading?: boolean | undefined;
  metadataUnavailable?: boolean | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  posterUrl: string;
  episodeCount?: number | undefined;
  format?: string | undefined;
  initialEpisode?: number | undefined;
  embedded?: boolean;
  initialSeasonId?: string | number | undefined;
  currentEpisode?: number | undefined;
  initialLanguage?: "sub" | "dub" | undefined;
  resume?: { label: string; onResume: () => void } | undefined;
  onClose: () => void;
  onPlay: (playerUrl: string, displayTitle: string, poster: string) => void;
}

function getStableSeasonSelection(
  seasonOptions: readonly Pick<AnimeSeason, "id" | "number">[],
  selectedSeasonId: string | number | null,
): string | number | null {
  if (
    selectedSeasonId !== null &&
    seasonOptions.some(
      (season) => String(season.id) === String(selectedSeasonId),
    )
  ) {
    return selectedSeasonId;
  }
  return (
    seasonOptions.find((season) => Number(season.number) === 1)?.id ??
    seasonOptions[0]?.id ??
    null
  );
}

function getSeasonOptionsForPicker(
  seasonsLoading: boolean,
  seasons?: readonly AnimeSeason[],
): AnimeSeason[] {
  if (seasonsLoading && !seasons?.length) return [];
  const seen = new Set<string>();
  return (seasons || [])
    .filter((season) => {
      if (isAnimeMovieFormat(season.format)) return false;
      const key = String(season.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const leftNumber = Number(left.number);
      const rightNumber = Number(right.number);
      const hasLeftNumber = Number.isFinite(leftNumber);
      const hasRightNumber = Number.isFinite(rightNumber);
      if (hasLeftNumber && hasRightNumber && leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      if (hasLeftNumber !== hasRightNumber) return hasLeftNumber ? -1 : 1;
      return 0;
    });
}

function getEpisodeNumbersForPicker(
  loadingEpisodes: boolean,
  anikotoEpisodes: readonly Pick<AnimeEpisodeMapping, "number">[],
  hasMultipleParts: boolean,
  maxEpisode: number,
  initialEpisode = 0,
): number[] {
  const hasEpisodeData = anikotoEpisodes.length > 0 || maxEpisode > 0;
  if (loadingEpisodes && !hasEpisodeData) return [];
  if (anikotoEpisodes.length > 0 && !hasMultipleParts) {
    return [...new Set(anikotoEpisodes.map((episode) => episode.number))].sort(
      (a, b) => a - b,
    );
  }
  return episodeNumbersForCount(maxEpisode, initialEpisode);
}

function getKnownEpisodeCount(
  format: string | undefined,
  episodeCount: number | undefined,
  parts: NonNullable<AnimeSeason["parts"]>,
): number {
  if (isAnimeMovieFormat(format)) return 1;
  if (parts.length > 1) {
    return playableAnimeParts(parts).reduce(
      (total, part) => total + part.episodeCount!,
      0,
    );
  }
  return episodeCount || 0;
}

const EpisodePickerModal = memo(function EpisodePickerModal({
  visible,
  title,
  year,
  ids,
  seasons,
  seasonsLoading = false,
  metadataUnavailable = false,
  anilistId,
  malId,
  posterUrl,
  episodeCount,
  format,
  initialEpisode,
  embedded = false,
  initialSeasonId,
  currentEpisode,
  initialLanguage = "sub",
  resume,
  onClose,
  onPlay,
}: EpisodePickerModalProps) {
  const identityIds = useMemo(
    () =>
      normalizeAnimeIds({
        ...ids,
        anilistId,
        malId,
      }),
    [ids, anilistId, malId],
  );
  const seasonOptions = useMemo(
    () => getSeasonOptionsForPicker(seasonsLoading, seasons),
    [seasons, seasonsLoading],
  );
  const [selectedSeasonId, setSelectedSeasonId] = useState<
    string | number | null
  >(initialSeasonId ?? null);
  const [isClosing, setIsClosing] = useState(false);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [anikotoEpisodes, setAnikotoEpisodes] = useState<AnimeEpisodeMapping[]>(
    [],
  );
  const [maxEpisode, setMaxEpisode] = useState(0);
  const [episodeDataKey, setEpisodeDataKey] = useState<string | null>(null);
  const [fetchedEpisodeKey, setFetchedEpisodeKey] = useState<string | null>(
    null,
  );
  const [resolvedParts, setResolvedParts] = useState<
    NonNullable<AnimeSeason["parts"]>
  >([]);
  const episodeRequestIdRef = useRef(0);
  const autoPlayedRef = useRef(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const activeSeasonId = getStableSeasonSelection(
    seasonOptions,
    selectedSeasonId,
  );
  const selectedSeason = seasonOptions.find(
    (season) => String(season.id) === String(activeSeasonId),
  );
  const activeTitle = selectedSeason?.title || title;
  const activeYear = selectedSeason ? selectedSeason.year : year;
  const activeFormat = selectedSeason?.format || format;
  const activeEpisodeCount = selectedSeason
    ? selectedSeason.episodeCount
    : episodeCount;
  const sourceParts = selectedSeason?.parts || [];
  const hasMultipleParts = sourceParts.length > 1;
  const partsKey = JSON.stringify(sourceParts);
  const activeIds = useMemo(
    () => normalizeAnimeIds(selectedSeason?.ids || identityIds),
    [identityIds, selectedSeason?.ids],
  );
  const activeIdsKey = useMemo(
    () =>
      `season:${String(activeSeasonId)}|parts:${partsKey}|${Object.entries(
        activeIds,
      )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, id]) => `${provider}:${id}`)
        .join("|")}`,
    [activeIds, activeSeasonId, partsKey],
  );
  const activeEntryKey = JSON.stringify([
    activeSeasonId,
    activeTitle,
    partsKey,
  ]);
  const knownEpisodeCount = getKnownEpisodeCount(
    activeFormat,
    activeEpisodeCount,
    sourceParts,
  );
  const hasCurrentEpisodeData = episodeDataKey === activeEntryKey;
  const activeParts =
    hasCurrentEpisodeData && resolvedParts.length > 1
      ? resolvedParts
      : sourceParts;
  const currentAnikotoEpisodes = hasCurrentEpisodeData
    ? anikotoEpisodes
    : NO_EPISODES;
  const currentMaxEpisode = hasCurrentEpisodeData
    ? maxEpisode
    : knownEpisodeCount;
  const currentLoadingEpisodes = hasCurrentEpisodeData
    ? loadingEpisodes
    : hasAnimeIdentity(activeIds);
  const awaitingFirstFetch =
    currentLoadingEpisodes && fetchedEpisodeKey !== activeEntryKey;

  const requestClose = useCallback(() => setIsClosing(true), []);
  const finishClose = useCallback(() => onCloseRef.current(), []);
  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: visible && !embedded,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: finishClose,
  });

  useEffect(() => {
    if (!visible) {
      episodeRequestIdRef.current += 1;
      setIsClosing(false);
      setLoadingEpisodes(false);
      setAnikotoEpisodes([]);
      setMaxEpisode(0);
      setEpisodeDataKey(null);
      setFetchedEpisodeKey(null);
      setResolvedParts([]);
      setSelectedSeasonId(initialSeasonId ?? null);
      autoPlayedRef.current = 0;
      return;
    }
    setSelectedSeasonId((current) =>
      getStableSeasonSelection(
        seasonOptions,
        current ?? initialSeasonId ?? null,
      ),
    );
  }, [visible, seasonOptions, initialSeasonId]);

  useEffect(() => {
    if (!visible) return;
    const requestId = episodeRequestIdRef.current + 1;
    episodeRequestIdRef.current = requestId;
    let cancelled = false;
    const isCurrentRequest = () =>
      !cancelled && episodeRequestIdRef.current === requestId;

    if (isAnimeMovieFormat(activeFormat)) {
      setLoadingEpisodes(false);
      setAnikotoEpisodes([]);
      setMaxEpisode(1);
      setEpisodeDataKey(activeEntryKey);
      return () => {
        cancelled = true;
      };
    }

    const hasDirectSeries = Boolean(activeIds.anikoto);
    const hasIdentity = hasAnimeIdentity(activeIds);
    const hasUsableEpisodeData =
      hasCurrentEpisodeData && (anikotoEpisodes.length > 0 || maxEpisode > 0);
    if (!hasUsableEpisodeData) {
      setAnikotoEpisodes([]);
      setResolvedParts(sourceParts);
      setMaxEpisode(knownEpisodeCount);
      setEpisodeDataKey(activeEntryKey);
    }
    if (!hasIdentity) {
      setAnikotoEpisodes([]);
      setMaxEpisode(knownEpisodeCount);
      setLoadingEpisodes(false);
      setEpisodeDataKey(activeEntryKey);
      return () => {
        cancelled = true;
      };
    }
    setLoadingEpisodes(true);

    const load = async () => {
      if (hasMultipleParts) {
        const parts = sourceParts.map((part) => ({ ...part }));
        await Promise.all(
          sourceParts.map(async (part, index) => {
            const count = await fetchAnimeEpisodeCount(part.ids);
            if (!isCurrentRequest()) return;
            parts[index] = {
              ...part,
              episodeCount: chooseEpisodeCount(part.episodeCount, count),
            };
          }),
        );
        if (!isCurrentRequest()) return;
        setResolvedParts(parts);
        setAnikotoEpisodes([]);
        setMaxEpisode(
          playableAnimeParts(parts).reduce(
            (total, part) => total + part.episodeCount!,
            0,
          ),
        );
        setEpisodeDataKey(activeEntryKey);
        setFetchedEpisodeKey(activeEntryKey);
        setLoadingEpisodes(false);
        return;
      }
      setResolvedParts([]);
      let directEpisodes: AnimeEpisodeMapping[] = [];
      if (hasDirectSeries) {
        directEpisodes = await fetchAnikotoEpisodes(activeIds).catch(() => []);
        if (!isCurrentRequest()) return;
        if (directEpisodes.length > 0) {
          setAnikotoEpisodes(directEpisodes);
          setMaxEpisode(
            Math.max(
              knownEpisodeCount,
              ...directEpisodes.map((episode) => episode.number),
            ),
          );
          setEpisodeDataKey(activeEntryKey);
          setFetchedEpisodeKey(activeEntryKey);
          setLoadingEpisodes(false);
          return;
        }
      }

      const resolvedCount = await fetchAnimeEpisodeCount(activeIds).catch(
        () => 0,
      );
      if (!isCurrentRequest()) return;
      if (directEpisodes.length === 0) setAnikotoEpisodes([]);
      setMaxEpisode(chooseEpisodeCount(knownEpisodeCount, resolvedCount));
      setEpisodeDataKey(activeEntryKey);
      setFetchedEpisodeKey(activeEntryKey);
      setLoadingEpisodes(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    activeSeasonId,
    activeIdsKey,
    activeEntryKey,
    activeEpisodeCount,
    activeFormat,
    initialEpisode,
    hasMultipleParts,
  ]);

  const playEpisode = useCallback(
    (episode: number) => {
      const mapping = currentAnikotoEpisodes.find(
        (item) => item.number === episode,
      );
      let partStart = 1;
      let playbackPart = undefined as (typeof activeParts)[number] | undefined;
      for (const part of activeParts) {
        const partCount = part.episodeCount || 0;
        if (partCount <= 0) return;
        if (
          partCount > 0 &&
          episode >= partStart &&
          episode < partStart + partCount
        ) {
          playbackPart = part;
          break;
        }
        partStart += partCount;
      }
      const sourceEpisode = playbackPart ? episode - partStart + 1 : episode;
      const playbackIds = playbackPart?.ids || activeIds;
      if (episode < 0 || (episode === 0 && !mapping?.anikotoEpisodeId)) return;
      onPlay(
        buildAnimePlaybackUrl({
          title: activeTitle,
          posterUrl,
          ids: mapping?.anikotoEpisodeId
            ? { ...playbackIds, anikotoEpisode: mapping.anikotoEpisodeId }
            : playbackIds,
          episode,
          season: selectedSeason?.number,
          sourceEpisode,
          episodeCount: currentMaxEpisode,
          year: activeYear,
          format: activeFormat,
          language: initialLanguage,
          parts: activeParts,
        }),
        activeTitle,
        posterUrl,
      );
    },
    [
      activeIds,
      activeTitle,
      posterUrl,
      activeYear,
      currentAnikotoEpisodes,
      currentMaxEpisode,
      activeFormat,
      initialLanguage,
      activeParts,
      selectedSeason?.number,
      onPlay,
    ],
  );

  const needsEpisodeMapping = Boolean(activeIds.anikoto) || hasMultipleParts;
  const canAutoPlay =
    !currentLoadingEpisodes ||
    (!needsEpisodeMapping &&
      !!initialEpisode &&
      currentMaxEpisode >= initialEpisode);

  useEffect(() => {
    if (
      !visible ||
      seasonsLoading ||
      !canAutoPlay ||
      !hasCurrentEpisodeData ||
      !initialEpisode ||
      autoPlayedRef.current === initialEpisode
    ) {
      return;
    }
    autoPlayedRef.current = initialEpisode;
    playEpisode(initialEpisode);
  }, [
    visible,
    initialEpisode,
    playEpisode,
    seasonsLoading,
    canAutoPlay,
    hasCurrentEpisodeData,
  ]);

  const episodeNumbers = useMemo(
    () =>
      (seasonsLoading && seasonOptions.length === 0) || awaitingFirstFetch
        ? []
        : getEpisodeNumbersForPicker(
            currentLoadingEpisodes,
            currentAnikotoEpisodes,
            hasMultipleParts,
            currentMaxEpisode,
            initialEpisode,
          ),
    [
      awaitingFirstFetch,
      currentAnikotoEpisodes,
      currentLoadingEpisodes,
      currentMaxEpisode,
      seasonOptions.length,
      hasMultipleParts,
      initialEpisode,
      seasonsLoading,
    ],
  );
  const {
    gridRef,
    range: episodeRange,
    visibleItems: visibleEpisodeNumbers,
  } = useVirtualGrid(episodeNumbers, visible, modalRef);

  if (!visible) return null;

  return (
    <div
      class={
        embedded
          ? "episode-picker-embedded"
          : `popup episode-picker-modal ${modalStateClass}`
      }
      ref={modalRef}
      onAnimationEnd={onAnimationEnd}
    >
      {!embedded && (
        <button
          class="modal-close-btn episode-picker-modal-close"
          aria-label="close"
          type="button"
          onClick={() => setIsClosing(true)}
          dangerouslySetInnerHTML={{ __html: SVG_XMARK }}
        />
      )}
      {!embedded && <h2>{title}</h2>}
      <div class="episode-picker-modal-body">
        {resume && (
          <button
            type="button"
            class="episode-selector-button episode-picker-resume"
            onClick={resume.onResume}
          >
            {resume.label}
          </button>
        )}
        {metadataUnavailable && (
          <span class="episode-picker-modal-label" role="status">
            {negativeMessage(
              "season metadata could not be refreshed; shown seasons may be incomplete or outdated",
            )}
          </span>
        )}
        {seasonOptions.length > 1 && (
          <div class="episode-season-tabs" role="tablist">
            {seasonOptions.map((season, index) => {
              const isActive = String(season.id) === String(activeSeasonId);
              return (
                <button
                  key={String(season.id)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  class={`episode-season-tab${isActive ? " is-active" : ""}`}
                  onClick={() => {
                    if (String(season.id) === String(activeSeasonId)) return;
                    setSelectedSeasonId(season.id);
                    setAnikotoEpisodes([]);
                    setMaxEpisode(0);
                    setEpisodeDataKey(null);
                    setLoadingEpisodes(true);
                    autoPlayedRef.current = 0;
                  }}
                >
                  season {season.number || index + 1}
                  {season.year ? ` · ${season.year}` : ""}
                </button>
              );
            })}
          </div>
        )}
        <span class="episode-picker-modal-label">
          {seasonsLoading && episodeNumbers.length === 0
            ? "finding seasons..."
            : currentLoadingEpisodes && episodeNumbers.length === 0
              ? "fetching episodes..."
              : "choose an episode"}
        </span>
        <div class="episode-selector-options episode-picker-options" ref={gridRef}>
          {episodeRange.topSpacer > 0 && (
            <div
              class="episode-picker-virtual-spacer"
              style={`height:${episodeRange.topSpacer}px`}
            />
          )}
          {visibleEpisodeNumbers.map((episode) => (
            <button
              key={episode}
              class={`episode-selector-button episode-picker-btn${currentEpisode === episode && String(activeSeasonId) === String(initialSeasonId) ? " is-active" : ""}`}
              type="button"
              onClick={() => playEpisode(episode)}
            >
              {episode}
            </button>
          ))}
          {episodeRange.bottomSpacer > 0 && (
            <div
              class="episode-picker-virtual-spacer"
              style={`height:${episodeRange.bottomSpacer}px`}
            />
          )}
        </div>
        {!seasonsLoading &&
          !currentLoadingEpisodes &&
          episodeNumbers.length === 0 && (
            <p class="episode-picker-modal-empty">
              {negativeMessage("episode data unavailable")}
            </p>
          )}
      </div>
    </div>
  );
});

export default EpisodePickerModal;
