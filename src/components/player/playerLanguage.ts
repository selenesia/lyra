import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { trackLanguage, type AudioTrack, trackPreference } from "./tracks.ts";
import { type StreamInfoResponse, fetchStreamInfo } from "./streamInfo.ts";
import type { PlayerSelector } from "./playerState.ts";
import {
  type AnimeProvider,
  hasMegaPlayIdentifier,
  appendMegaPlayParams,
} from "../../features/anime/animeIdentity.ts";
import { showToast } from "../../core/ui/toast.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import type { MediaState } from "../../core/media/mediaState.ts";
import Hls from "hls.js";

interface LanguageSwitchContext {
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
  language: "sub" | "dub";
  changingLanguage: boolean;
  episodeNumber: number;
  playbackIds: Partial<Record<AnimeProvider, string>>;
  languageRequestRef: MutableRef<AbortController | null>;
  setChangingLanguage: Dispatch<StateUpdater<boolean>>;
  videoRef: MutableRef<HTMLVideoElement | null>;
  sourceEpisodeNumber: number;
  streamSessionRef: MutableRef<string>;
  auto4k: boolean;
  sourceContextRef: MutableRef<string>;
  sourceContextGenerationRef: MutableRef<number>;
  sourceSwitchTimeRef: MutableRef<number | null>;
  pendingSeekRef: MutableRef<number | null>;
  playAfterSeekRef: MutableRef<boolean>;
  playIntentRef: MutableRef<boolean>;
  persistProgress: (currentTime: number, duration: number, completed?: boolean) => void;
  mediaStateRef: MutableRef<MediaState>;
  languageStreamInfoRef: MutableRef<{ params: string; info: StreamInfoResponse } | null>;
  nextAudioLanguageRef: MutableRef<"sub" | "dub">;
  audioPreferenceRef: MutableRef<string>;
  audioPreferencesRef: MutableRef<{ sub: string; dub: string }>;
  setLanguage: Dispatch<StateUpdater<"sub" | "dub">>;
}

export async function switchPlayerLanguage({
  setOpenSelector, language, changingLanguage, episodeNumber, playbackIds,
  languageRequestRef, setChangingLanguage, videoRef, sourceEpisodeNumber,
  streamSessionRef, auto4k, sourceContextRef, sourceContextGenerationRef,
  sourceSwitchTimeRef, pendingSeekRef, playAfterSeekRef, playIntentRef,
  persistProgress, mediaStateRef, languageStreamInfoRef, nextAudioLanguageRef,
  audioPreferenceRef, audioPreferencesRef, setLanguage,
}: LanguageSwitchContext, nextLanguage: "sub" | "dub") {
    setOpenSelector(null);
    if (
      nextLanguage === language ||
      changingLanguage ||
      !(episodeNumber > 0 || playbackIds.anikotoEpisode) ||
      !hasMegaPlayIdentifier(playbackIds)
    ) {
      return;
    }
    const controller = new AbortController();
    languageRequestRef.current?.abort();
    languageRequestRef.current = controller;
    setChangingLanguage(true);
    const video = videoRef.current;
    const params = new URLSearchParams({
      episode: String(sourceEpisodeNumber),
      language: nextLanguage,
      session: streamSessionRef.current,
    });
    if (auto4k) params.set("preferred_quality", "auto");
    appendMegaPlayParams(params, playbackIds);
    const requestContext = sourceContextRef.current;
    const requestGeneration = sourceContextGenerationRef.current;
    try {
      const info = await fetchStreamInfo(params, controller.signal);
      if (
        controller.signal.aborted ||
        requestContext !== sourceContextRef.current ||
        requestGeneration !== sourceContextGenerationRef.current
      ) {
        return;
      }
      if (info.source?.language !== nextLanguage) {
        throw new RequestError("selected audio is unconfirmed", {
          code: "AUDIO_LANGUAGE_UNCONFIRMED",
        });
      }
      sourceSwitchTimeRef.current = Math.max(
        0,
        pendingSeekRef.current ?? video?.currentTime ?? 0,
      );
      playAfterSeekRef.current = playIntentRef.current;
      if (video && video.currentTime > 0) {
        persistProgress(
          video.currentTime,
          mediaStateRef.current.duration || 0,
          video.ended,
        );
      }
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("language", nextLanguage);
      currentUrl.searchParams.delete("mochi_url");
      window.history.replaceState(null, "", currentUrl);
      languageStreamInfoRef.current = { params: params.toString(), info };
      nextAudioLanguageRef.current = nextLanguage;
      audioPreferenceRef.current =
        audioPreferencesRef.current[nextLanguage] ||
        trackPreference({
          id: "",
          label: "",
          language: nextLanguage === "sub" ? "ja" : "en",
        });
      try {
        localStorage.setItem("lyra-anime-audio", audioPreferenceRef.current);
      } catch {}
      setLanguage(nextLanguage);
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestContext !== sourceContextRef.current ||
        requestGeneration !== sourceContextGenerationRef.current
      ) {
        return;
      }
      const code =
        error instanceof RequestError
          ? error.code
          : "AUDIO_LANGUAGE_UNAVAILABLE";
      recordStreamDiagnostic("audio_language_error", {
        language: nextLanguage,
        code,
        status: error instanceof RequestError ? error.status : undefined,
      });
      showToast(
        "error",
        code === "AUDIO_LANGUAGE_UNCONFIRMED"
          ? "selected audio is unconfirmed"
          : "selected audio is unavailable",
        undefined,
        4000,
      );
    } finally {
      if (languageRequestRef.current === controller) {
        languageRequestRef.current = null;
        setChangingLanguage(false);
      }
    }
  }

interface AudioPickContext {
  audioTracks: AudioTrack[];
  audioTracksReady: boolean;
  tracksSourceRef: MutableRef<string>;
  videoSrc: string;
  hlsRef: MutableRef<Hls | null>;
  setActiveAudioTrack: Dispatch<StateUpdater<number>>;
  audioChoiceRef: MutableRef<{ source: string; id: string }>;
  audioPreferenceRef: MutableRef<string>;
  nextAudioLanguageRef: MutableRef<"sub" | "dub">;
  audioPreferencesRef: MutableRef<{ sub: string; dub: string }>;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
}

export function pickAudioTrack({
  audioTracks, audioTracksReady, tracksSourceRef, videoSrc, hlsRef,
  setActiveAudioTrack, audioChoiceRef, audioPreferenceRef, nextAudioLanguageRef,
  audioPreferencesRef, setOpenSelector,
}: AudioPickContext, index: number) {
    const track = audioTracks[index];
    if (!track || !audioTracksReady || tracksSourceRef.current !== videoSrc)
      return;
    const hls = hlsRef.current;
    if (track.hlsIndex !== undefined) {
      if (!hls || !hls.audioTracks[track.hlsIndex]) return;
      hls.audioTrack = track.hlsIndex;
    } else if (track.nativeTrack) {
      for (const candidate of audioTracks) {
        if (candidate.nativeTrack)
          candidate.nativeTrack.enabled = candidate === track;
      }
      setActiveAudioTrack(index);
    } else {
      return;
    }
    audioChoiceRef.current = { source: videoSrc, id: track.id };
    const preference = trackPreference(track);
    audioPreferenceRef.current = preference;
    const code = trackLanguage(track.language, track.label).split("-")[0];
    const version = code === "ja" ? "sub" : code === "en" ? "dub" : null;
    if (version) {
      nextAudioLanguageRef.current = version;
      audioPreferencesRef.current[version] = preference;
    }
    try {
      localStorage.setItem("lyra-anime-audio", preference);
      if (version) localStorage.setItem(`lyra-anime-audio-${version}`, preference);
    } catch {}
    setOpenSelector(null);
  }
