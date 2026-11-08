import type { MutableRef } from "preact/hooks";
import type { AutoNextState } from "./playerEpisodes.ts";
import {
  IconVolumeOff,
  IconVolumeMinimum,
  IconVolumeHalf,
  IconVolumeFull,
} from "../icons/index.tsx";

interface VolumeControlContext {
  muted: boolean;
  volume: number;
  toggleMute: () => void;
  volumeSliderRef: MutableRef<HTMLInputElement | null>;
  handleVolume: (event: Event) => void;
  volumeDraggingRef: MutableRef<boolean>;
  resetTimer: () => void;
}

export function renderVolumeControl({
  muted, volume, toggleMute, volumeSliderRef, handleVolume, volumeDraggingRef,
  resetTimer,
}: VolumeControlContext) {
  return (
    <div class="volume-wrapper">
      <button
        class="player-btn"
        aria-label={muted || volume === 0 ? "unmute" : "mute"}
        onClick={toggleMute}
      >
        {muted || volume === 0 ? (
          <IconVolumeOff size={24} />
        ) : volume <= 33 ? (
          <IconVolumeMinimum size={24} />
        ) : volume <= 66 ? (
          <IconVolumeHalf size={24} />
        ) : (
          <IconVolumeFull size={24} />
        )}
      </button>
      <div
        class="volume-slider-wrap"
        style={{ "--vol-pct": `${muted ? 0 : volume}%` } as any}
      >
        <input
          type="range"
          class="volume-slider"
          min="0"
          max="100"
          value={muted ? 0 : volume}
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
