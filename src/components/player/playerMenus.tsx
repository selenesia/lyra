import type { Dispatch, StateUpdater } from "preact/hooks";
import type { SubtitleTrack, AudioTrack } from "./tracks.ts";
import type { StreamQualityOption } from "./streamInfo.ts";
import type { PlayerSelector } from "./playerState.ts";
import { PlayerMenu, PlayerOption } from "./PlayerMenu.tsx";
import { IconBubbleText, IconChevronBottom, IconPeople } from "../icons/index.tsx";
import ChatAvatar from "../chat/ChatAvatar.tsx";
import PlayerPartyInvite from "./PlayerPartyInvite.tsx";
import {
  displayName,
  type ChatParty,
  type ChatPartyControl,
  type ChatChannel,
} from "../../features/chat/chatProtocol.ts";
import EpisodePickerModal from "../anime/EpisodePickerModal.tsx";
import TitleEpisodePicker from "../watch/TitleEpisodePicker.tsx";
import type { AnimeProvider } from "../../features/anime/animeIdentity.ts";
import {
  type AnimeSeason,
  isAnimeMovieFormat,
} from "../../features/anime/anime.ts";
import { qualityMenuLabel } from "../../core/media/hlsQuality.ts";
import { providerServerLabel } from "./playerProvider.ts";
import {
  type CaptionStyle,
  type CaptionStyleName,
  CAPTION_STYLE_NAMES,
  CAPTION_STYLE_OPTIONS,
  isDefaultCaptionStyle,
} from "./captionStyle.ts";

export type PlayerMenuSelector = PlayerSelector | "party" | "party-invite";

interface QualityMenuContext {
  qualityOptions: StreamQualityOption[];
  hasRemote4k: boolean;
  openSelector: PlayerMenuSelector | null;
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
  openSelector: PlayerMenuSelector | null;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  activeSubtitle: number;
  subtitleTracks: SubtitleTrack[];
  selectedSubtitle: number;
  chooseSubtitle: (index: number) => void;
  subtitleMenuLabels: string[];
  captionStyle: CaptionStyle;
  chooseCaptionStyle: (name: CaptionStyleName, value: string) => void;
  resetCaptionStyle: () => void;
}

export function renderSubtitleMenu({
  openSelector, setOpenSelector, activeSubtitle, subtitleTracks,
  selectedSubtitle, chooseSubtitle, subtitleMenuLabels, captionStyle,
  chooseCaptionStyle, resetCaptionStyle,
}: SubtitleMenuContext) {
  const styling = openSelector === "captionStyle";
  const open = styling || openSelector === "subtitles";
  return (
    <PlayerMenu
      className="player-subtitle-control"
      open={open}
      onToggle={() =>
        setOpenSelector((current) =>
          current === "subtitles" || current === "captionStyle"
            ? null
            : "subtitles",
        )
      }
      triggerClassName={`player-btn player-btn-cc${activeSubtitle >= 0 ? " is-active" : " is-off"}`}
      panelClassName={`player-subtitle-options${styling ? " player-caption-options" : ""}`}
      panelRole={styling ? "group" : "listbox"}
      ariaLabel="subtitles"
      disabled={subtitleTracks.length === 0}
      label={<IconBubbleText size={24} />}
    >
      {styling ? (
        <div class="player-caption-style">
          <button
            type="button"
            class="player-caption-back"
            onClick={() => setOpenSelector("subtitles")}
          >
            <IconChevronBottom size={12} class="player-caption-back-icon" />
            <span>subtitle style</span>
          </button>
          <div class="player-menu-divider" role="separator" />
          {CAPTION_STYLE_NAMES.map((name) => (
            <div key={name} class="player-caption-row">
              <span class="player-caption-label" id={`caption-style-${name}`}>
                {name}
              </span>
              <div
                class="player-caption-choices"
                role="radiogroup"
                aria-labelledby={`caption-style-${name}`}
              >
                {CAPTION_STYLE_OPTIONS[name].map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={captionStyle[name] === value}
                    class={`settings-page-button${captionStyle[name] === value ? " is-primary" : ""}`}
                    onClick={() => chooseCaptionStyle(name, value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            class="settings-page-button player-caption-reset"
            disabled={isDefaultCaptionStyle(captionStyle)}
            onClick={resetCaptionStyle}
          >
            reset to default
          </button>
        </div>
      ) : (
        <>
          <PlayerOption
            open={open}
            selected={selectedSubtitle < 0}
            solid
            onSelect={() => chooseSubtitle(-1)}
          >
            off
          </PlayerOption>
          {subtitleTracks.map((track, index) => (
            <PlayerOption
              key={track.id}
              open={open}
              selected={selectedSubtitle === index}
              solid
              onSelect={() => chooseSubtitle(index)}
            >
              {subtitleMenuLabels[index]?.toLowerCase()}
            </PlayerOption>
          ))}
          <div class="player-menu-divider" role="separator" />
          <button
            type="button"
            class="player-caption-open"
            tabIndex={open ? 0 : -1}
            onClick={() => setOpenSelector("captionStyle")}
          >
            <span>subtitle style</span>
            <IconChevronBottom size={12} class="player-caption-open-icon" />
          </button>
        </>
      )}
    </PlayerMenu>
  );
}

interface AudioMenuContext {
  streamProvider: string | null;
  audioTracksReady: boolean;
  audioTracks: AudioTrack[];
  openSelector: PlayerMenuSelector | null;
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
      (streamProvider === "orion" && (!audioTracksReady || audioTracks.length > 0)) ||
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
  openSelector: PlayerMenuSelector | null;
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

interface ProviderMenuContext {
  providers: string[];
  activeProvider: string | null;
  providerChoice: string;
  openSelector: PlayerMenuSelector | null;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  changingProvider: boolean;
  changeProvider: (provider: string) => Promise<void>;
}

export function renderProviderMenu({
  providers, activeProvider, providerChoice, openSelector, setOpenSelector,
  changingProvider, changeProvider,
}: ProviderMenuContext) {
  const open = openSelector === "provider";
  const autoServer = providerServerLabel(providers, activeProvider);
  const label = providerChoice
    ? providerServerLabel(providers, providerChoice) || "server"
    : autoServer ? `auto · ${autoServer}` : "auto";
  return (
    providers.length > 1 && (
      <PlayerMenu
        className="player-provider-selector"
        open={open}
        onToggle={() =>
          setOpenSelector((current) =>
            current === "provider" ? null : "provider",
          )
        }
        disabled={changingProvider}
        panelClassName="player-audio-options"
        ariaLabel="server"
        label={changingProvider ? "switching" : label}
      >
        <PlayerOption
          open={open}
          selected={!providerChoice}
          solid
          onSelect={() => void changeProvider("")}
        >
          {autoServer && !providerChoice ? `auto · ${autoServer}` : "auto"}
        </PlayerOption>
        {providers.map((provider) => (
          <PlayerOption
            key={provider}
            open={open}
            selected={providerChoice === provider}
            solid
            onSelect={() => void changeProvider(provider)}
          >
            {providerServerLabel(providers, provider)}
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

interface PartyMenuContext {
  party: ChatParty | null;
  isHost: boolean;
  openSelector: PlayerMenuSelector | null;
  setOpenSelector: Dispatch<StateUpdater<PlayerMenuSelector | null>>;
  setControl: (control: ChatPartyControl) => void;
  copyInvite: () => void;
  leave: () => void;
  end: () => void;
  invite: (channels: ChatChannel[]) => Promise<boolean>;
}

export function renderPartyMenu({
  party, isHost, openSelector, setOpenSelector, setControl, copyInvite, leave,
  end, invite,
}: PartyMenuContext) {
  const sharing = !party || openSelector === "party-invite";
  const open = openSelector === "party" || openSelector === "party-invite";
  const choose = (action: () => void) => () => {
    setOpenSelector(null);
    action();
  };
  const details = party ? [party.label, `hosted by ${party.hostName}`].filter(Boolean).join(" · ") : "";
  return (
    <PlayerMenu
      className="player-party-control"
      open={open}
      onToggle={() =>
        setOpenSelector(open ? null : "party")
      }
      triggerClassName="player-btn player-btn-party"
      panelClassName="player-party-options"
      panelRole="group"
      ariaLabel={party ? `watch party, ${party.watchers.length} watching` : "start a watch party"}
      label={
        <>
          <IconPeople size={24} />
          {party && <span class="player-party-count">{party.watchers.length}</span>}
        </>
      }
    >
      {sharing ? <PlayerPartyInvite open={open} target={party?.target} invite={invite} onDone={() => setOpenSelector(null)} /> : party && <>
      <div class="player-party-heading">
        <strong>{party.title}</strong>
        <span>{details}</span>
      </div>
      <div class="player-party-watchers" role="list" aria-label="watching">
        {party.watchers.map((member) => (
          <div key={member.author} class="player-party-watcher" role="listitem">
            <ChatAvatar member={member} size={20} />
            <span class="player-party-name">{displayName(member)}</span>
            {member.author === party.host && <span class="player-party-host">host</span>}
          </div>
        ))}
      </div>
      <div class="player-menu-divider" role="separator" />
      {isHost && (
        <>
          <PlayerOption
            open={open}
            selected={party.control === "everyone"}
            solid
            onSelect={choose(() => setControl("everyone"))}
          >
            everyone can control
          </PlayerOption>
          <PlayerOption
            open={open}
            selected={party.control === "host"}
            solid
            onSelect={choose(() => setControl("host"))}
          >
            only i control
          </PlayerOption>
          <div class="player-menu-divider" role="separator" />
        </>
      )}
      <PlayerOption open={open} onSelect={choose(copyInvite)}>
        copy invite link
      </PlayerOption>
      <PlayerOption open={open} onSelect={() => setOpenSelector("party-invite")}>
        invite in chat
      </PlayerOption>
      <PlayerOption open={open} onSelect={choose(leave)}>
        leave party
      </PlayerOption>
      {isHost && (
        <PlayerOption open={open} onSelect={choose(end)}>
          end party
        </PlayerOption>
      )}
      </>}
    </PlayerMenu>
  );
}
