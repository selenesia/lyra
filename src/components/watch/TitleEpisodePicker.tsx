import { memo } from "preact/compat";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useManagedModal } from "../../core/ui/modal.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { useVirtualGrid } from "../../hooks/useVirtualGrid.ts";
import {
  fetchTitleDetails,
  fetchTitleSeason,
  playableSeasons,
  type TitleEpisode,
  type TitleSeasonSummary,
} from "../../features/watch/titles.ts";
import { buildTitlePlaybackUrl } from "../../features/watch/watchPlayback.ts";
import "../../assets/styles/watch/episode-selector.css";
import "../../assets/styles/watch/episode-picker-modal.css";

const SVG_XMARK = svgIcon("IconCrossMedium");

export interface TitleEpisodeChoice {
  season: number;
  episode: number;
  episodeCount: number;
}

interface TitleEpisodePickerProps {
  visible: boolean;
  embedded?: boolean;
  id: string;
  title: string;
  posterUrl: string;
  year?: number | undefined;
  initialSeason?: number | undefined;
  currentSeason?: number | undefined;
  currentEpisode?: number | undefined;
  language?: string | undefined;
  resume?: { label: string; onResume: () => void } | undefined;
  onClose: () => void;
  onPlay: (playerUrl: string, displayTitle: string, poster: string, choice: TitleEpisodeChoice) => void;
}

const TitleEpisodePicker = memo(function TitleEpisodePicker({
  visible,
  embedded = false,
  id,
  title,
  posterUrl,
  year,
  initialSeason,
  currentSeason,
  currentEpisode,
  language,
  resume,
  onClose,
  onPlay,
}: TitleEpisodePickerProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [seasons, setSeasons] = useState<TitleSeasonSummary[]>([]);
  const [seasonsState, setSeasonsState] = useState<"loading" | "ready" | "failed">("loading");
  const [selectedSeason, setSelectedSeason] = useState<number | null>(initialSeason ?? null);
  const [episodes, setEpisodes] = useState<TitleEpisode[]>([]);
  const [episodesKey, setEpisodesKey] = useState("");
  const [episodesFailed, setEpisodesFailed] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      setIsClosing(false);
      return;
    }
    const controller = new AbortController();
    setSeasonsState("loading");
    fetchTitleDetails("tv", id, controller.signal)
      .then((details) => {
        const options = playableSeasons(details.seasons);
        setSeasons(options);
        setSeasonsState("ready");
        setSelectedSeason((current) =>
          current !== null && options.some((season) => season.number === current)
            ? current
            : (options.find((season) => season.number > 0) ?? options[0])?.number ?? null,
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSeasonsState("failed");
        setSelectedSeason((current) => current ?? 1);
      });
    return () => controller.abort();
  }, [visible, id]);

  const activeKey = selectedSeason === null ? "" : `${id}:${selectedSeason}`;
  useEffect(() => {
    if (!visible || selectedSeason === null) return;
    const controller = new AbortController();
    setEpisodesFailed(false);
    fetchTitleSeason(id, selectedSeason, controller.signal)
      .then((season) => {
        setEpisodes(season.episodes);
        setEpisodesKey(`${id}:${selectedSeason}`);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setEpisodes([]);
        setEpisodesKey(`${id}:${selectedSeason}`);
        setEpisodesFailed(true);
      });
    return () => controller.abort();
  }, [visible, id, selectedSeason]);

  const currentEpisodes = episodesKey === activeKey ? episodes : [];
  const loadingEpisodes = selectedSeason !== null && episodesKey !== activeKey;
  const episodeCount = currentEpisodes.reduce((highest, episode) => Math.max(highest, episode.number), 0);
  const { gridRef, range, visibleItems } = useVirtualGrid(currentEpisodes, visible, modalRef);

  const playEpisode = useCallback(
    (episode: TitleEpisode) => {
      if (selectedSeason === null) return;
      onPlay(
        buildTitlePlaybackUrl({
          type: "tv",
          id,
          season: selectedSeason,
          episode: episode.number,
          episodeCount,
          title,
          posterUrl,
          year,
          language,
        }),
        title,
        posterUrl,
        { season: selectedSeason, episode: episode.number, episodeCount },
      );
    },
    [selectedSeason, onPlay, id, episodeCount, title, posterUrl, year, language],
  );

  const seasonLabel = useMemo(
    () => (season: TitleSeasonSummary) =>
      season.number === 0 ? "specials" : `season ${season.number}${season.airDate ? ` · ${season.airDate.slice(0, 4)}` : ""}`,
    [],
  );

  if (!visible) return null;

  return (
    <div
      class={embedded ? "episode-picker-embedded" : `popup episode-picker-modal ${modalStateClass}`}
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
          <button type="button" class="episode-selector-button episode-picker-resume" onClick={resume.onResume}>
            {resume.label}
          </button>
        )}
        {seasonsState === "failed" && (
          <span class="episode-picker-modal-label" role="status">
            {negativeMessage("season list could not be loaded; showing season 1")}
          </span>
        )}
        {seasons.length > 1 && (
          <div class="episode-season-tabs" role="tablist">
            {seasons.map((season) => {
              const isActive = season.number === selectedSeason;
              return (
                <button
                  key={season.number}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  class={`episode-season-tab${isActive ? " is-active" : ""}`}
                  onClick={() => setSelectedSeason(season.number)}
                >
                  {seasonLabel(season)}
                </button>
              );
            })}
          </div>
        )}
        <span class="episode-picker-modal-label">
          {seasonsState === "loading" && selectedSeason === null
            ? "finding seasons..."
            : loadingEpisodes
              ? "fetching episodes..."
              : "choose an episode"}
        </span>
        <div class="episode-selector-options episode-picker-options" ref={gridRef}>
          {range.topSpacer > 0 && <div class="episode-picker-virtual-spacer" style={`height:${range.topSpacer}px`} />}
          {visibleItems.map((episode) => (
            <button
              key={episode.number}
              class={`episode-selector-button episode-picker-btn${currentEpisode === episode.number && currentSeason === selectedSeason ? " is-active" : ""}`}
              type="button"
              title={episode.name.toLowerCase()}
              aria-label={`episode ${episode.number}: ${episode.name.toLowerCase()}`}
              onClick={() => playEpisode(episode)}
            >
              {episode.number}
            </button>
          ))}
          {range.bottomSpacer > 0 && (
            <div class="episode-picker-virtual-spacer" style={`height:${range.bottomSpacer}px`} />
          )}
        </div>
        {!loadingEpisodes && (episodesFailed || (selectedSeason !== null && currentEpisodes.length === 0)) && (
          <p class="episode-picker-modal-empty">{negativeMessage("episode data unavailable")}</p>
        )}
      </div>
    </div>
  );
});

export default TitleEpisodePicker;
