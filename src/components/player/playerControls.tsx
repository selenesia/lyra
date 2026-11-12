import type { MutableRef } from "preact/hooks";
import type { AutoNextState } from "./playerEpisodes.ts";
import {
  IconVolumeOff,
  IconVolumeMinimum,
  IconVolumeHalf,
  IconVolumeFull,
} from "../icons/index.tsx";
import { VOLUME_SLIDER_MAX, volumeLevelToSlider } from "./volumeBoost.ts";

interface VolumeControlContext {
  muted: boolean;
  volumeLevel: number;
  boostable: boolean;
  toggleMute: () => void;
  volumeSliderRef: MutableRef<HTMLInputElement | null>;
  handleVolume: (event: Event) => void;
  volumeDraggingRef: MutableRef<boolean>;
  resetTimer: () => void;
}

export function renderVolumeControl({
  muted, volumeLevel, boostable, toggleMute, volumeSliderRef, handleVolume,
  volumeDraggingRef, resetTimer,
}: VolumeControlContext) {
  const silent = muted || volumeLevel === 0;
  const boosted = !silent && volumeLevel > 100;
  const sliderMax = boostable ? VOLUME_SLIDER_MAX : 100;
  const sliderValue = silent
    ? 0
    : boostable
      ? volumeLevelToSlider(volumeLevel)
      : volumeLevel;
  const percent = silent ? 0 : Math.round(volumeLevel);
  return (
    <div class={`volume-wrapper${boosted ? " is-boosted" : ""}`}>
      <button
        class="player-btn"
        aria-label={silent ? "unmute" : "mute"}
        onClick={toggleMute}
      >
        {silent ? (
          <IconVolumeOff size={24} />
        ) : volumeLevel <= 33 ? (
          <IconVolumeMinimum size={24} />
        ) : volumeLevel <= 66 ? (
          <IconVolumeHalf size={24} />
        ) : (
          <IconVolumeFull size={24} />
        )}
      </button>
      <div
        class={`volume-slider-wrap${boostable ? " is-boostable" : ""}`}
        style={{ "--vol-pct": `${(sliderValue / sliderMax) * 100}%` } as any}
      >
        <input
          type="range"
          class="volume-slider"
          min="0"
          max={sliderMax}
          aria-valuetext={`${percent}%`}
          value={sliderValue}
          ref={volumeSliderRef}
          onInput={handleVolume}
          onPointerDown={() => {
            volumeDraggingRef.current = true;
            resetTimer();
          }}
          onPointerUp={() => {
            volumeDraggingRef.current = false;
            resetTimer();
          }}
          onPointerCancel={() => {
            volumeDraggingRef.current = false;
            resetTimer();
          }}
          onLostPointerCapture={() => {
            volumeDraggingRef.current = false;
            resetTimer();
          }}
          aria-label="volume"
        />
      </div>
      {boosted && (
        <span class="volume-boost-label" aria-hidden="true">
          {percent}%
        </span>
      )}
    </div>
  );
}

interface AutoNextNoticeContext {
  autoNext: AutoNextState | null;
  continueNextSeason: () => void;
  clearAutoNext: () => void;
  changeEpisode: (nextEpisode: number, autoplay?: boolean) => void;
}

export function renderAutoNextNotice({
  autoNext, clearAutoNext, changeEpisode, continueNextSeason,
}: AutoNextNoticeContext) {
  return (
    autoNext && (
      <div
        class="player-next-episode-card"
        role="status"
        aria-live="polite"
      >
        <div class="player-next-episode-copy">
          <span>up next</span>
          <strong>
            {autoNext.season !== undefined ? `season ${autoNext.season} · ` : ""}episode {autoNext.episode}
          </strong>
          <small>playing in {autoNext.seconds}s</small>
        </div>
        <div class="player-next-episode-actions">
          <button
            type="button"
            class="player-action-button player-action-button-secondary"
            onClick={clearAutoNext}
          >
            cancel
          </button>
          <button
            type="button"
            class="player-action-button"
            onClick={() => {
              const nextEpisode = autoNext.episode;
              const nextSeason = autoNext.season;
              clearAutoNext();
              if (nextSeason !== undefined) continueNextSeason();
              else changeEpisode(nextEpisode, true);
            }}
          >
            play now
          </button>
        </div>
      </div>
    )
  );
}
