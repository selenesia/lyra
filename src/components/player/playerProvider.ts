import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { type StreamInfoResponse, fetchStreamInfo } from "./streamInfo.ts";
import type { PlayerSelector } from "./playerState.ts";
import { showToast } from "../../core/ui/toast.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import type { MediaState } from "../../core/media/mediaState.ts";

export function readProviderChoice(params: URLSearchParams): string {
  const previousNames: Record<string, string> = { vela: "luna", cygnus: "nova", ara: "vega", pyxis: "mira" };
  const requested = params.get("provider") || "";
  const provider = (Object.hasOwn(previousNames, requested) ? previousNames[requested] : undefined) ?? requested;
  return /^[a-z0-9-]{1,32}$/.test(provider) && provider !== "auto" ? provider : "";
}

export function providerServerLabel(providers: readonly string[], provider: string | null): string | null {
  const index = provider ? providers.indexOf(provider) : -1;
  return index < 0 ? null : provider;
}

interface ProviderSwitchContext {
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  providerChoice: string;
  changingProvider: boolean;
  language: string;
  qualityRequest: string;
  streamParams: (language: string, qualityRequest: string, provider?: string) => URLSearchParams | null;
  providerRequestRef: MutableRef<AbortController | null>;
  setChangingProvider: Dispatch<StateUpdater<boolean>>;
  videoRef: MutableRef<HTMLVideoElement | null>;
  sourceContextRef: MutableRef<string>;
  sourceContextGenerationRef: MutableRef<number>;
  sourceSwitchTimeRef: MutableRef<number | null>;
  pendingSeekRef: MutableRef<number | null>;
  playAfterSeekRef: MutableRef<boolean>;
  playIntentRef: MutableRef<boolean>;
  persistProgress: (currentTime: number, duration: number, completed?: boolean) => void;
  mediaStateRef: MutableRef<MediaState>;
  languageStreamInfoRef: MutableRef<{ params: string; info: StreamInfoResponse } | null>;
  setProviderChoice: Dispatch<StateUpdater<string>>;
}

export async function switchPlayerProvider({
  setOpenSelector, providerChoice, changingProvider, language, qualityRequest,
  streamParams, providerRequestRef, setChangingProvider, videoRef,
  sourceContextRef, sourceContextGenerationRef, sourceSwitchTimeRef,
  pendingSeekRef, playAfterSeekRef, playIntentRef, persistProgress,
  mediaStateRef, languageStreamInfoRef, setProviderChoice,
}: ProviderSwitchContext, nextProvider: string) {
  setOpenSelector(null);
  const params = streamParams(language, qualityRequest, nextProvider);
  if (nextProvider === providerChoice || changingProvider || !params) return;
  const controller = new AbortController();
  providerRequestRef.current?.abort();
  providerRequestRef.current = controller;
  setChangingProvider(true);
  const video = videoRef.current;
  const requestContext = sourceContextRef.current;
  const requestGeneration = sourceContextGenerationRef.current;
  const stale = () =>
    controller.signal.aborted ||
    requestContext !== sourceContextRef.current ||
    requestGeneration !== sourceContextGenerationRef.current;
  try {
    const info = await fetchStreamInfo(params, controller.signal);
    if (stale()) return;
    sourceSwitchTimeRef.current = Math.max(
      0,
      pendingSeekRef.current ?? video?.currentTime ?? 0,
    );
    playAfterSeekRef.current = playIntentRef.current;
    if (video && video.currentTime > 0) {
      persistProgress(video.currentTime, mediaStateRef.current.duration || 0, video.ended);
    }
    const currentUrl = new URL(window.location.href);
    if (nextProvider) currentUrl.searchParams.set("provider", nextProvider);
    else currentUrl.searchParams.delete("provider");
    window.history.replaceState(null, "", currentUrl);
    languageStreamInfoRef.current = { params: params.toString(), info };
    setProviderChoice(nextProvider);
  } catch (error) {
    if (stale()) return;
    recordStreamDiagnostic("provider_switch_error", {
      provider: nextProvider || "auto",
      code: error instanceof RequestError ? error.code : "PROVIDER_UNAVAILABLE",
      status: error instanceof RequestError ? error.status : undefined,
    });
    showToast("error", "this server is unavailable right now", undefined, 4000);
  } finally {
    if (providerRequestRef.current === controller) {
      providerRequestRef.current = null;
      setChangingProvider(false);
    }
  }
}
