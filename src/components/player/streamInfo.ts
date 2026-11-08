import { RequestError } from "../../core/runtime/messages.ts";

const STREAM_INFO_TIMEOUT_MS = 23_000;

export interface StreamQualityOption {
  index: number;
  label: string;
  width: number;
  height: number;
  bitrate: number;
}

export interface StreamInfoResponse {
  duration?: number | null;
  needs_transmux?: boolean;
  hls?: boolean;
  quality_fallback?: boolean;
  available_4k?: boolean;
  tracks?: unknown;
  media?: "anime" | "movie" | "tv";
  languages?: unknown;
  source?: {
    provider?: string;
    id?: string;
    server?: number | string;
    language?: "sub" | "dub" | string | null;
    url?: string;
  };
  intro?: { start: number; end: number } | null;
  outro?: { start: number; end: number } | null;
  qualities?: Array<{
    index: number;
    width?: number;
    height?: number;
    bitrate?: number;
    codecs?: string;
  }>;
}

export async function fetchStreamInfo(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<StreamInfoResponse> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "stream information request timed out... /ᐠ - ˕ -マ",
          "TimeoutError",
        ),
      ),
    STREAM_INFO_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`/stream/info?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RequestError("stream information request failed", {
        code: "STREAM_INFO_UNAVAILABLE",
        status: response.status,
      });
    }
    return (await response.json()) as StreamInfoResponse;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new RequestError("stream information request timed out", {
        code: "STREAM_INFO_TIMEOUT",
      });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function hlsLoadPolicy(
  maxTimeToFirstByteMs: number,
  maxLoadTimeMs: number,
  timeoutRetries: number,
  errorRetries: number,
) {
  return {
    default: {
      maxTimeToFirstByteMs,
      maxLoadTimeMs,
      timeoutRetry: {
        maxNumRetry: timeoutRetries,
        retryDelayMs: 500,
        maxRetryDelayMs: 4_000,
        backoff: "exponential" as const,
      },
      errorRetry: {
        maxNumRetry: errorRetries,
        retryDelayMs: 500,
        maxRetryDelayMs: 5_000,
        backoff: "exponential" as const,
      },
    },
  };
}
