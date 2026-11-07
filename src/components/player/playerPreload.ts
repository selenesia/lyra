import Hls from "hls.js";
import type { MutableRef } from "preact/hooks";
import {
  type PlaybackEpisodePartRange,
  buildNextEpisodeStreamUrl,
} from "./episodeParts.ts";
import type { AnimeProvider } from "../../features/anime/animeIdentity.ts";
import { isAnimeMovieFormat } from "../../features/anime/anime.ts";

interface PreloadContext {
  preloadSource: string;
  videoSrc: string;
  episodeNumber: number;
  episodeCount: number;
  format: string;
  episodeParts: PlaybackEpisodePartRange[];
  identityIds: Partial<Record<AnimeProvider, string>>;
  language: "sub" | "dub";
  streamSessionRef: MutableRef<string>;
  auto4k: boolean;
}

export function preloadNextEpisode({
  preloadSource, videoSrc, episodeNumber, episodeCount, format, episodeParts,
  identityIds, language, streamSessionRef, auto4k,
}: PreloadContext) {
  if (
    preloadSource !== videoSrc ||
    episodeNumber < 1 ||
    episodeCount <= episodeNumber ||
    isAnimeMovieFormat(format)
  ) {
    return;
  }
  const nextVideoSrc = buildNextEpisodeStreamUrl(
    episodeNumber + 1,
    episodeParts,
    identityIds,
    language,
    streamSessionRef.current,
    auto4k ? "auto" : "",
  );
  if (!nextVideoSrc) return;

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
