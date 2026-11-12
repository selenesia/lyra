import Hls, { type ErrorData } from "hls.js";

export function createSourceRecovery(
  stop: () => void,
  refresh: () => void,
) {
  let attempts = 0;
  let position: number | undefined;
  let played = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    recover(error: ErrorData): boolean {
      if (
        disposed || error.type !== Hls.ErrorTypes.NETWORK_ERROR ||
        error.frag?.type === "subtitle" ||
        error.details === Hls.ErrorDetails.SUBTITLE_LOAD_ERROR ||
        error.details === Hls.ErrorDetails.SUBTITLE_TRACK_LOAD_TIMEOUT
      ) return false;
      if (timer !== undefined) return true;
      if (error.response?.code !== 409 || attempts >= 4) return false;
      attempts += 1;
      played = 0;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) refresh();
      }, 250);
      stop();
      return true;
    },
    progress(currentTime: number) {
      if (!Number.isFinite(currentTime)) return;
      const elapsed = position === undefined ? 0 : currentTime - position;
      position = currentTime;
      if (timer === undefined && elapsed > 0 && elapsed <= 2) played += elapsed;
      if (played >= 10) attempts = 0;
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
