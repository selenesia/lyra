import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import type { PlayerSelector } from "./playerState.ts";

interface PlayerShortcutsContext {
  selectorOpenRef: MutableRef<boolean>;
  containerRef: MutableRef<HTMLDivElement | null>;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  setPartyChatOpen: Dispatch<StateUpdater<boolean>>;
  resetTimer: () => void;
  videoRef: MutableRef<HTMLVideoElement | null>;
  displayDurationRef: MutableRef<number>;
  seekTo: (seconds: number) => void;
  togglePlay: () => void;
  pendingSeekRef: MutableRef<number | null>;
  stepVolume: (delta: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  toggleCaptions: () => void;
  setSpeed: (speed: number) => void;
}

export function attachPlayerShortcuts({
  selectorOpenRef, containerRef, setOpenSelector, setPartyChatOpen, resetTimer,
  videoRef, displayDurationRef, seekTo, togglePlay, pendingSeekRef, stepVolume,
  toggleMute, toggleFullscreen, toggleCaptions, setSpeed,
}: PlayerShortcutsContext) {
  const handleKeydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === "Escape" && selectorOpenRef.current) {
      event.preventDefault();
      containerRef.current
        ?.querySelector<HTMLElement>('[aria-expanded="true"]')
        ?.focus();
      setOpenSelector(null);
      setPartyChatOpen(false);
      resetTimer();
      return;
    }
    if (
      target?.closest(
        'input, textarea, select, button, a, [role="slider"], [contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    const video = videoRef.current;
    if (!video) return;
    if (
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      /^[0-9]$/.test(event.key)
    ) {
      const duration = displayDurationRef.current;
      if (!duration) return;
      event.preventDefault();
      seekTo(duration * (Number(event.key) / 10));
      return;
    }
    resetTimer();
    switch (event.key.toLowerCase()) {
      case " ":
        event.preventDefault();
        togglePlay();
        break;
      case "k":
        togglePlay();
        break;
      case "arrowleft":
        event.preventDefault();
        seekTo((pendingSeekRef.current ?? video.currentTime) - 5);
        break;
      case "arrowright":
        event.preventDefault();
        seekTo((pendingSeekRef.current ?? video.currentTime) + 5);
        break;
      case "j":
        seekTo((pendingSeekRef.current ?? video.currentTime) - 10);
        break;
      case "l":
        seekTo((pendingSeekRef.current ?? video.currentTime) + 10);
        break;
      case "arrowup":
        event.preventDefault();
        stepVolume(5);
        break;
      case "arrowdown":
        event.preventDefault();
        stepVolume(-5);
        break;
      case "m":
        toggleMute();
        break;
      case "f":
        toggleFullscreen();
        break;
      case "c":
        event.preventDefault();
        toggleCaptions();
        break;
      case ">":
        setSpeed(Math.min(2, video.playbackRate + 0.25));
        break;
      case "<":
        setSpeed(Math.max(0.5, video.playbackRate - 0.25));
        break;
    }
  };
  document.addEventListener("keydown", handleKeydown);
  return () => document.removeEventListener("keydown", handleKeydown);
}
