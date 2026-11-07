import Hls from "hls.js";
import type { MutableRef } from "preact/hooks";
import type { MediaStateHints } from "../../core/media/mediaState.ts";

interface PlaybackToggleContext {
  videoRef: MutableRef<HTMLVideoElement | null>;
  playRequestRef: MutableRef<number>;
  playIntentRef: MutableRef<boolean>;
  hlsRef: MutableRef<Hls | null>;
  playAfterSeekRef: MutableRef<boolean>;
  syncMediaState: (patch?: MediaStateHints) => void;
}

export function togglePlayback({
  videoRef, playRequestRef, playIntentRef, hlsRef, playAfterSeekRef,
  syncMediaState,
}: PlaybackToggleContext) {
  const video = videoRef.current;
  if (!video) return;
  if (video.paused) {
    if (video.ended) {
      try {
        video.currentTime = 0;
      } catch {}
    }
    const requestId = ++playRequestRef.current;
    playIntentRef.current = true;
    hlsRef.current?.resumeBuffering();
    video.play().catch(() => {
      if (requestId !== playRequestRef.current) return;
      playIntentRef.current = false;
      playAfterSeekRef.current = false;
      hlsRef.current?.pauseBuffering();
      syncMediaState({ buffering: false, bufferingReason: null });
    });
  } else {
    playRequestRef.current += 1;
    playIntentRef.current = false;
    playAfterSeekRef.current = false;
    video.pause();
    hlsRef.current?.pauseBuffering();
  }
}
