import Hls from "hls.js";

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
      enableWorker: true,
      backBufferLength: 0,
      maxBufferLength: 12,
      maxMaxBufferLength: 12,
    });
    hls.attachMedia(preloadVideo);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls?.loadSource(nextVideoSrc);
    });
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
