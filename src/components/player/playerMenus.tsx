import type { Dispatch, StateUpdater } from "preact/hooks";
import type { SubtitleTrack, AudioTrack } from "./tracks.ts";
import type { StreamQualityOption } from "./streamInfo.ts";
import type { PlayerSelector } from "./playerState.ts";
import { PlayerMenu, PlayerOption } from "./PlayerMenu.tsx";
import { IconBubbleText, IconChevronBottom } from "../icons/index.tsx";
import EpisodePickerModal from "../anime/EpisodePickerModal.tsx";
import TitleEpisodePicker from "../watch/TitleEpisodePicker.tsx";
import type { AnimeProvider } from "../../features/anime/animeIdentity.ts";
import {
  type AnimeSeason,
  isAnimeMovieFormat,
} from "../../features/anime/anime.ts";
import { qualityMenuLabel } from "../../core/media/hlsQuality.ts";

interface QualityMenuContext {
  qualityOptions: StreamQualityOption[];
  hasRemote4k: boolean;
  openSelector: PlayerSelector | null;
  refreshAutoQuality: () => void;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  selectedQualityLabel: string;
  selectedQuality: number;
  chooseQuality: (index: number) => void;
  autoQualityName: string | null;
  chooseRemote4k: () => void;
}

export function renderQualityMenu({
  qualityOptions, hasRemote4k, openSelector, refreshAutoQuality,
  setOpenSelector, selectedQualityLabel, selectedQuality, chooseQuality,
  autoQualityName, chooseRemote4k,
}: QualityMenuContext) {
  return (
    (qualityOptions.length > 1 || hasRemote4k) && (
      <PlayerMenu
        className="player-quality-selector"
        open={openSelector === "quality"}
        onToggle={() => {
          if (openSelector !== "quality") refreshAutoQuality();
          setOpenSelector((current) =>
            current === "quality" ? null : "quality",
          );
        }}
        panelClassName="player-quality-options"
        label={selectedQualityLabel}
      >
        <PlayerOption
          open={openSelector === "quality"}
          selected={selectedQuality < 0}
          solid
          onSelect={() => chooseQuality(-1)}
        >
          {qualityMenuLabel(null, autoQualityName)}
        </PlayerOption>
        {hasRemote4k && (
          <PlayerOption
            open={openSelector === "quality"}
            selected={false}
            solid
            onSelect={chooseRemote4k}
          >
            4k
          </PlayerOption>
        )}
        {qualityOptions.map((option) => (
          <PlayerOption
            key={`${option.index}-${option.label}`}
            open={openSelector === "quality"}
            selected={selectedQuality === option.index}
            solid
            onSelect={() => chooseQuality(option.index)}
          >
            {option.label}
          </PlayerOption>
        ))}
      </PlayerMenu>
    )
  );
}

interface SubtitleMenuContext {
  openSelector: PlayerSelector | null;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  activeSubtitle: number;
  subtitleTracks: SubtitleTrack[];
  selectedSubtitle: number;
  chooseSubtitle: (index: number) => void;
  subtitleMenuLabels: string[];
}

export function renderSubtitleMenu({
  openSelector, setOpenSelector, activeSubtitle, subtitleTracks,
  selectedSubtitle, chooseSubtitle, subtitleMenuLabels,
}: SubtitleMenuContext) {
  return (
    <PlayerMenu
      className="player-subtitle-control"
      open={openSelector === "subtitles"}
      onToggle={() =>
        setOpenSelector((current) =>
          current === "subtitles" ? null : "subtitles",
        )
      }
      triggerClassName={`player-btn player-btn-cc${activeSubtitle >= 0 ? " is-active" : " is-off"}`}
      panelClassName="player-subtitle-options"
      ariaLabel="subtitles"
      disabled={subtitleTracks.length === 0}
      label={<IconBubbleText size={24} />}
    >
      <PlayerOption
        open={openSelector === "subtitles"}
        selected={selectedSubtitle < 0}
        solid
        onSelect={() => chooseSubtitle(-1)}
      >
        off
      </PlayerOption>
      {subtitleTracks.map((track, index) => (
        <PlayerOption
          key={track.id}
          open={openSelector === "subtitles"}
          selected={selectedSubtitle === index}
          solid
          onSelect={() => chooseSubtitle(index)}
        >
          {subtitleMenuLabels[index]?.toLowerCase()}
        </PlayerOption>
      ))}
    </PlayerMenu>
  );
}

interface AudioMenuContext {
  streamProvider: string | null;
  audioTracksReady: boolean;
  audioTracks: AudioTrack[];
  openSelector: PlayerSelector | null;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  activeAudioLabel: string;
  loadingStreamInfo: boolean;
  selectedAudioTrack: number;
  chooseAudioTrack: (index: number) => void;
  audioMenuLabels: string[];
}

export function renderAudioMenu({
  streamProvider, audioTracksReady, audioTracks, openSelector, setOpenSelector,
  activeAudioLabel, loadingStreamInfo, selectedAudioTrack, chooseAudioTrack,
  audioMenuLabels,
}: AudioMenuContext) {
  return (
    (streamProvider === null ||
      (streamProvider === "framex" && (!audioTracksReady || audioTracks.length > 0)) ||
      audioTracks.length > 1) && (
      <PlayerMenu
        className="player-audio-selector"
        open={openSelector === "audio"}
        onToggle={() =>
          setOpenSelector((current) =>
            current === "audio" ? null : "audio",
          )
        }
        label={activeAudioLabel.toLowerCase()}
        panelClassName="player-audio-options"
        ariaLabel="audio language"
        disabled={
          !audioTracksReady ||
          loadingStreamInfo ||
          audioTracks.length <= 1 ||
          streamProvider === null
        }
      >
        {audioTracks.map((track, index) => (
          <PlayerOption
            key={track.id}
            open={openSelector === "audio"}
            selected={selectedAudioTrack === index}
            solid
            onSelect={() => chooseAudioTrack(index)}
          >
            {audioMenuLabels[index]?.toLowerCase()}
          </PlayerOption>
        ))}
      </PlayerMenu>
    )
  );
}

export interface LanguageOption {
  value: string;
  label: string;
}

interface LanguageMenuContext {
  visible: boolean;
  openSelector: PlayerSelector | null;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  changingLanguage: boolean;
  loadingStreamInfo: boolean;
  value: string;
  label: string;
  options: LanguageOption[];
  changeLanguage: (nextLanguage: string) => Promise<void>;
}

export function renderLanguageMenu({
  visible, openSelector, setOpenSelector, changingLanguage,
  loadingStreamInfo, value, label, options, changeLanguage,
}: LanguageMenuContext) {
  return (
    visible && (
      <PlayerMenu
        className="player-language-selector"
        open={openSelector === "language"}
        onToggle={() =>
          setOpenSelector((current) =>
            current === "language" ? null : "language",
          )
        }
        disabled={changingLanguage || loadingStreamInfo}
        panelClassName="player-audio-options"
        label={label}
      >
        {options.map((option) => (
          <PlayerOption
            key={option.value}
            open={openSelector === "language"}
            selected={option.value === value}
            solid
            onSelect={() => void changeLanguage(option.value)}
          >
            {option.label}
          </PlayerOption>
        ))}
      </PlayerMenu>
    )
  );
}

interface EpisodeMenuContext {
  format: string;
  episodeSelectorOpen: boolean;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  confirmedEpisodeNumber: number | null;
  setEpisodeSelectorMounted: Dispatch<StateUpdater<boolean>>;
  title: string;
  episodeSelectorRendered: boolean;
  identityIds: Partial<Record<AnimeProvider, string>>;
  poster: string;
  currentSeason: AnimeSeason;
  pickerSeasons: AnimeSeason[];
  language: string;
  closeSelector: () => void;
  playPickedEpisode: (playerUrl: string) => void;
  show: { id: string; season: number } | null;
}

export function renderEpisodeMenu({
  format, episodeSelectorOpen, setOpenSelector, confirmedEpisodeNumber,
  setEpisodeSelectorMounted, title, episodeSelectorRendered, identityIds,
  poster, currentSeason, pickerSeasons, language, closeSelector,
  playPickedEpisode, show,
}: EpisodeMenuContext) {
  return (
    !isAnimeMovieFormat(format) && (
      <div class="player-control-popover player-episode-control">
        <button
          type="button"
          class={`player-selector-selected player-episode-trigger${episodeSelectorOpen ? " is-open" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={episodeSelectorOpen}
          onClick={(event) => {
            event.stopPropagation();
            setOpenSelector((current) =>
              current === "episodes" ? null : "episodes",
            );
          }}
        >
          <span>
            {show ? `s${show.season} ` : ""}ep {confirmedEpisodeNumber ?? "?"}
          </span>
          <IconChevronBottom size={12} class="selector-chevron" />
        </button>
        <div
          class={`player-selector-options player-episode-panel${episodeSelectorOpen ? " is-open" : ""}`}
          role="dialog"
          aria-label="choose a season and episode"
          aria-hidden={!episodeSelectorOpen}
          onTransitionEnd={(event) => {
            if (
              episodeSelectorOpen ||
              event.target !== event.currentTarget ||
              event.propertyName !== "opacity"
            ) {
              return;
            }
            setEpisodeSelectorMounted(false);
          }}
        >
          <div class="player-episode-heading">
            <div>
              <strong>{title}</strong>
            </div>
          </div>
          {episodeSelectorRendered && show && (
            <TitleEpisodePicker
              embedded
              visible={episodeSelectorRendered}
              id={show.id}
              title={title}
              posterUrl={poster}
              year={currentSeason.year}
              initialSeason={show.season}
              currentSeason={show.season}
              currentEpisode={confirmedEpisodeNumber ?? undefined}
              language={language}
              onClose={closeSelector}
              onPlay={playPickedEpisode}
            />
          )}
          {episodeSelectorRendered && !show && (
            <EpisodePickerModal
              embedded
              visible={episodeSelectorRendered}
              title={title}
              type="anime"
              ids={identityIds}
              posterUrl={poster}
              format={format}
              year={currentSeason.year}
              episodeCount={pickerSeasons[0]!.episodeCount}
              seasons={pickerSeasons}
              initialSeasonId={currentSeason.id}
              currentEpisode={confirmedEpisodeNumber ?? undefined}
              initialLanguage={language === "dub" ? "dub" : "sub"}
              onClose={closeSelector}
              onPlay={playPickedEpisode}
            />
          )}
        </div>
      </div>
    )
  );
}
