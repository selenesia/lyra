import type { HlsConfig } from "hls.js";
import workerPath from "hls.js/dist/hls.worker.js?url";

export const HLS_PLAYBACK_CONFIG = {
  enableWorker: true,
  workerPath,
  preferManagedMediaSource: false,
  useMediaCapabilities: true,
} satisfies Partial<HlsConfig>;
