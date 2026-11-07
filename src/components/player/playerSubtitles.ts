import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import {
  trackRole,
  trackPreference,
  trackLanguage,
  type SubtitleTrack,
} from "./tracks.ts";
import {
  readAnimeSubtitles,
  ANIME_SUBTITLE_PREFERENCES,
} from "../../core/media/animeSettings.ts";
import type { MediaState } from "../../core/media/mediaState.ts";
import { type PlayerSelector, SUBTITLE_PREFERENCE_KEY } from "./playerState.ts";

interface SidecarSubtitleContext {
  selectedSidecar: SubtitleTrack | undefined;
  loadedSubtitle: { source: string; id: string; url: string } | null;
  videoSrc: string;
  sourceContextKey: string;
  sourceContextRef: MutableRef<string>;
  subtitleRetryRef: MutableRef<boolean>;
  failSubtitle: (id: string, notify?: boolean, status?: number | undefined) => void;
  setInfoRevision: Dispatch<StateUpdater<number>>;
  setLoadedSubtitle: Dispatch<StateUpdater<{ source: string; id: string; url: string } | null>>;
}

export function loadSidecarSubtitle({
  selectedSidecar, loadedSubtitle, videoSrc, sourceContextKey, sourceContextRef,
  subtitleRetryRef, failSubtitle, setInfoRevision, setLoadedSubtitle,
}: SidecarSubtitleContext) {
  if (
    !selectedSidecar?.src ||
    (loadedSubtitle?.source === videoSrc &&
      loadedSubtitle.id === selectedSidecar.id)
  )
    return;
  const track = selectedSidecar;
  const controller = new AbortController();
  let cancelled = false;
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  void (async () => {
    try {
      const response = await fetch(track.src!, { signal: controller.signal });
      if (cancelled || sourceContextKey !== sourceContextRef.current) return;
      if (response.status === 409 && !subtitleRetryRef.current) {
        subtitleRetryRef.current = true;
        failSubtitle(track.id, false, 409);
        setInfoRevision((revision) => revision + 1);
        return;
      }
      if (!response.ok) {
        failSubtitle(track.id, true, response.status);
        return;
      }
      const body = await response.blob();
      if (cancelled || sourceContextKey !== sourceContextRef.current) return;
      const objectUrl = URL.createObjectURL(body);
      setLoadedSubtitle({ source: videoSrc, id: track.id, url: objectUrl });
    } catch {
      if (!cancelled) failSubtitle(track.id);
    } finally {
      window.clearTimeout(timeout);
    }
  })();
  return () => {
    cancelled = true;
    controller.abort();
    window.clearTimeout(timeout);
  };
}

interface SubtitlePickContext {
  subtitleTracks: SubtitleTrack[];
  lastSubtitlePreferenceRef: MutableRef<string>;
  selectedSubtitle: number;
  setSubtitlePreference: Dispatch<StateUpdater<string>>;
  setSubtitleChoice: Dispatch<StateUpdater<{ source: string; id: string }>>;
  videoSrc: string;
  setOpenSelector: Dispatch<StateUpdater<PlayerSelector | null>>;
}

export function pickSubtitle({
  subtitleTracks, lastSubtitlePreferenceRef, selectedSubtitle,
  setSubtitlePreference, setSubtitleChoice, videoSrc, setOpenSelector,
}: SubtitlePickContext, index: number) {
    if (index < -1 || index >= subtitleTracks.length) return;
    const selected = subtitleTracks[index];
    const preference = selected ? trackPreference(selected) : "off";
    if (selected) {
      lastSubtitlePreferenceRef.current = preference;
    } else if (subtitleTracks[selectedSubtitle]) {
      lastSubtitlePreferenceRef.current = trackPreference(
        subtitleTracks[selectedSubtitle],
      );
    }
    setSubtitlePreference(preference);
    setSubtitleChoice({ source: videoSrc, id: selected?.id || "" });
    try {
      localStorage.setItem(SUBTITLE_PREFERENCE_KEY, preference);
    } catch {}
    setOpenSelector(null);
  }

interface SubtitlePreferenceContext {
  loadingStreamInfo: boolean;
  mediaState: MediaState;
  subtitlePreference: string;
  subtitleTracks: SubtitleTrack[];
  notifyPreference: (key: string, message: string) => void;
}

export function checkSubtitlePreference({
  loadingStreamInfo, mediaState, subtitlePreference, subtitleTracks,
  notifyPreference,
}: SubtitlePreferenceContext) {
  const preference = readAnimeSubtitles();
  if (
    loadingStreamInfo ||
    mediaState.readyState < 2 ||
    (preference !== "english" && preference !== "english (forced)") ||
    subtitlePreference !== ANIME_SUBTITLE_PREFERENCES[preference]
  )
    return;
  const available = subtitleTracks.some(
    (track) =>
      trackLanguage(track.language, track.label).split("-")[0] === "en" &&
      (preference === "english (forced)"
        ? trackRole(track) === "forced"
        : ["main", "sdh"].includes(trackRole(track))),
  );
  if (available) return;
  const timer = window.setTimeout(() => {
    notifyPreference(
      `subtitles:${preference}`,
      "selected subs are unavailable",
    );
  }, 1500);
  return () => window.clearTimeout(timer);
}
