import Hls from "hls.js";
import { HLS_PLAYBACK_CONFIG } from "./hlsConfig.ts";

interface PreloadContext {
  preloadSource: string;
  videoSrc: string;
  nextVideoSrc: string;
}

export function preloadNextEpisode({
  preloadSource, videoSrc, nextVideoSrc,
}: PreloadContext) {
  if (preloadSource !== videoSrc || !nextVideoSrc) return;

  const preloadVideo = document.createElement("video");
  preloadVideo.preload = "auto";
  preloadVideo.crossOrigin = "anonymous";
  preloadVideo.muted = true;
  preloadVideo.playsInline = true;
  let hls: Hls | null = null;

  if (Hls.isSupported()) {
    hls = new Hls({
      ...HLS_PLAYBACK_CONFIG,
      backBufferLength: 0,
      maxBufferLength: 12,
      maxMaxBufferLength: 12,
    });
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls?.loadSource(nextVideoSrc);
    });
    hls.attachMedia(preloadVideo);
  } else if (preloadVideo.canPlayType("application/vnd.apple.mpegurl")) {
    preloadVideo.src = nextVideoSrc;
    preloadVideo.load();
  }

  return () => {
    hls?.destroy();
    preloadVideo.pause();
    preloadVideo.removeAttribute("src");
    preloadVideo.load();
  };
}
