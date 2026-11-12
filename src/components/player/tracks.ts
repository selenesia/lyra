export interface MediaTrack {
  id: string;
  label: string;
  language: string;
  default?: boolean;
  forced?: boolean;
  kind?: string;
  characteristics?: string;
}

export interface SubtitleTrack extends MediaTrack {
  src?: string;
  hlsIndex?: number;
  nativeTrack?: TextTrack;
}

interface NativeAudioTrack {
  id: string;
  label: string;
  language: string;
  kind: string;
  enabled: boolean;
}

export interface AudioTrack extends MediaTrack {
  hlsIndex?: number;
  nativeTrack?: NativeAudioTrack;
}

export type NativeAudioTrackList = EventTarget & ArrayLike<NativeAudioTrack>;

const languageNames: Record<string, string> = {
  english: "en",
  japanese: "ja",
  español: "es",
  spanish: "es",
  french: "fr",
  français: "fr",
  german: "de",
  deutsch: "de",
  portuguese: "pt",
  português: "pt",
  italian: "it",
  italiano: "it",
  arabic: "ar",
  russian: "ru",
  korean: "ko",
  chinese: "zh",
  indonesian: "id",
  thai: "th",
  turkish: "tr",
  vietnamese: "vi",
  malay: "ms",
  hindi: "hi",
  polish: "pl",
  dutch: "nl",
  日本語: "ja",
  한국어: "ko",
  中文: "zh",
  العربية: "ar",
  русский: "ru",
};
const languageAliases: Record<string, string> = {
  fre: "fr",
  ger: "de",
  chi: "zh",
  dut: "nl",
  cze: "cs",
  rum: "ro",
  gre: "el",
  per: "fa",
  may: "ms",
  alb: "sq",
  arm: "hy",
  baq: "eu",
  bur: "my",
  geo: "ka",
  ice: "is",
  mac: "mk",
  slo: "sk",
  tib: "bo",
  wel: "cy",
};

function languageCode(value: string): string {
  const tag = value.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag)) return "";
  const [primary = "", ...rest] = tag.split("-");
  if (["und", "mul", "zxx", "sub", "dub"].includes(primary)) return "";
  try {
    return (
      Intl.getCanonicalLocales(
        [languageAliases[primary] || primary, ...rest].join("-"),
      )[0]?.toLowerCase() || ""
    );
  } catch {
    return "";
  }
}

export function trackLanguage(language = "", label = ""): string {
  const code = languageCode(language);
  if (code) return code;
  const prefix = label.trim().split(/[\s([]/, 1)[0] || "";
  const labelCode = ["sdh", "cc", "sub", "dub"].includes(prefix.toLowerCase())
    ? ""
    : languageCode(prefix);
  if (labelCode) return labelCode;
  const tokens = `${language} ${label}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u);
  for (const token of tokens) {
    const name = languageNames[token];
    if (name) {
      if (name === "zh" && /traditional|hant/i.test(`${language} ${label}`))
        return "zh-hant";
      if (name === "zh" && /simplified|hans/i.test(`${language} ${label}`))
        return "zh-hans";
      return name;
    }
  }
  return "und";
}

export function trackRole(
  track: Pick<MediaTrack, "label" | "forced" | "kind" | "characteristics">,
): string {
  if (
    track.forced ||
    /\bforced\b/i.test(track.label) ||
    (/\b(signs?|songs?)\b/i.test(track.label) &&
      !/\b(full|dialogue)\b/i.test(track.label))
  )
    return "forced";
  if (/\bcommentary\b/i.test(track.label) || track.kind === "commentary")
    return "commentary";
  if (
    /\baudio description\b|\bdescriptive\b/i.test(track.label) ||
    track.kind === "descriptions" ||
    track.characteristics?.includes("describes-video")
  )
    return "description";
  if (
    /\b(sdh|cc)\b/i.test(track.label) ||
    track.kind === "captions" ||
    track.characteristics?.includes("describes-music-and-sound")
  )
    return "sdh";
  return "main";
}

export function trackLabel(
  track: Pick<MediaTrack, "label" | "language">,
  index: number,
  type: "audio" | "subtitles",
): string {
  const label = track.label.trim();
  const language = trackLanguage(track.language, label);
  if (
    label &&
    !/^(audio|subtitles?|captions?|unknown|und)$/i.test(label) &&
    languageCode(label) !== language
  )
    return label;
  if (language !== "und") {
    try {
      return (
        new Intl.DisplayNames(["en"], { type: "language" })
          .of(language)
          ?.toLowerCase() || language
      );
    } catch {}
  }
  return `${type} ${index + 1}`;
}

export function audioLabels(tracks: AudioTrack[], compact: boolean): string[] {
  const languages = tracks.map((track) =>
    trackLanguage(track.language, track.label).split("-")[0],
  );
  const versions =
    compact &&
    languages.every((language) => language === "ja" || language === "en");
  return tracks.map((track, index) => {
    const label = versions
      ? languages[index] === "ja"
        ? "sub"
        : "dub"
      : trackLabel(track, index, "audio");
    const role = trackRole(track);
    return versions && role !== "main" ? `${label} (${role})` : label;
  });
}

export function subtitleLabels(tracks: SubtitleTrack[]): string[] {
  const labels = tracks.map((track, index) => {
    const label = trackLabel(track, index, "subtitles");
    const role = trackRole(track);
    return role === "forced" && !/\b(forced|signs?|songs?)\b/i.test(label)
      ? `${label} (forced)`
      : role === "sdh" && !/\b(sdh|cc|captions)\b/i.test(label)
        ? `${label} (cc)`
        : label;
  });
  return labels.map((label, index) => {
    if (
      labels.filter((other) => other.toLowerCase() === label.toLowerCase())
        .length < 2
    )
      return label;
    const source = tracks[index]?.src ? "external" : "embedded";
    const duplicates = labels.filter(
      (other, i) =>
        other.toLowerCase() === label.toLowerCase() &&
        Boolean(tracks[i]?.src) === Boolean(tracks[index]?.src),
    ).length;
    return `${label} (${source}${duplicates > 1 ? ` ${index + 1}` : ""})`;
  });
}

export function trackPreference(track: MediaTrack): string {
  return JSON.stringify({
    language: trackLanguage(track.language, track.label),
    label: track.label.trim().toLowerCase(),
    role: trackRole(track),
  });
}

function readPreference(
  saved: string,
): { language: string; label: string; role: string } | null {
  if (!saved || saved === "off") return null;
  try {
    const value = JSON.parse(saved);
    if (
      typeof value?.language === "string" &&
      typeof value?.label === "string"
    ) {
      return {
        language: trackLanguage(value.language, value.label),
        label: value.label.trim().toLowerCase(),
        role: value.role || trackRole(value),
      };
    }
  } catch {}
  const separator = saved.indexOf("|");
  if (separator < 0) return null;
  const label = saved
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  return {
    language: trackLanguage(saved.slice(0, separator), label),
    label,
    role: trackRole({ label }),
  };
}

export function preferredAudioVersion(
  saved: string,
  fallback: "sub" | "dub",
): "sub" | "dub" {
  const language = readPreference(saved)?.language.split("-")[0];
  return language === "ja" ? "sub" : language === "en" ? "dub" : fallback;
}

function languageMatch(language: string, preferred: string): number {
  if (language === "und" || preferred === "und") return 0;
  if (language === preferred) return 2;
  return language.split("-")[0] === preferred.split("-")[0] ? 1 : 0;
}

export function selectTrack(
  tracks: MediaTrack[],
  saved: string,
  type: "audio" | "subtitles",
  version: "sub" | "dub",
  selectedId?: string,
): number {
  if (type === "subtitles" && saved === "off") return -1;
  const selected = tracks.findIndex((track) => track.id === selectedId);
  if (selected >= 0) return selected;
  const preference = readPreference(saved);
  const language = type === "audio" && version === "sub" ? "ja" : "en";
  let best = -1;
  let bestScore = -Infinity;
  for (const [index, track] of tracks.entries()) {
    const code = trackLanguage(track.language, track.label);
    const role = trackRole(track);
    const preferredLanguage = preference
      ? languageMatch(code, preference.language)
      : 0;
    const preferredLabel =
      preference?.label === track.label.trim().toLowerCase();
    const preferredRole = preference?.role === role;
    const compatibleRole =
      preference &&
      ["main", "sdh"].includes(preference.role) &&
      ["main", "sdh"].includes(role);
    const auxiliaryAudio = role === "commentary" || role === "description";
    const matches =
      preference &&
      (!auxiliaryAudio || preferredRole) &&
      (preferredLanguage ||
        (code === "und" && preference.language === "und" && preferredLabel));
    if (
      type === "subtitles" &&
      !matches &&
      code !== "und" &&
      !languageMatch(code, language)
    )
      continue;
    const score =
      (matches
        ? 1000 +
          preferredLanguage * 50 +
          (preferredRole ? 400 : compatibleRole ? 200 : 0) +
          (preferredLabel ? 30 : 0)
        : languageMatch(code, language) * 100 +
          (role ===
          (type === "subtitles" && version === "dub" ? "forced" : "main")
            ? 40
            : 0) -
          (auxiliaryAudio ? 500 : 0)) + (track.default ? 20 : 0);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

export function externalSubtitleTracks(values: unknown): SubtitleTrack[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!value || typeof value.src !== "string" || !value.src.trim()) return [];
    const kind =
      typeof value.kind === "string"
        ? value.kind.trim().toLowerCase()
        : "subtitles";
    if (kind && kind !== "subtitles" && kind !== "captions") return [];
    if (seen.has(value.src)) return [];
    seen.add(value.src);
    return [
      {
        id: value.src,
        src: value.src,
        label: typeof value.label === "string" ? value.label.trim() : "",
        language: trackLanguage(
          typeof value.language === "string" ? value.language : "",
          typeof value.label === "string" ? value.label : "",
        ),
        kind: kind || "subtitles",
        default: value.default === true,
        forced: value.forced === true,
      },
    ];
  });
}

export function applySubtitleTrack(
  video: HTMLVideoElement,
  selected: SubtitleTrack | undefined,
  hls: { subtitleTrack: number; subtitleDisplay: boolean } | null,
): boolean {
  const element = selected?.src
    ? Array.from(video.querySelectorAll<HTMLTrackElement>("track")).find(
        (track) =>
          track.getAttribute("data-track-id") === selected.id ||
          track.getAttribute("src") === selected.src,
      )
    : undefined;
  const native = selected?.nativeTrack || element?.track;
  if (hls) {
    const index = selected?.hlsIndex ?? -1;
    hls.subtitleDisplay = false;
    if (hls.subtitleTrack !== index) hls.subtitleTrack = index;
  }
  if (selected?.hlsIndex === undefined) {
    for (const track of Array.from(video.textTracks)) {
      if (track.kind !== "subtitles" && track.kind !== "captions") continue;
      const mode = track === native ? "hidden" : "disabled";
      if (track.mode !== mode) track.mode = mode;
    }
  }
  return Boolean(
    selected &&
      (selected.hlsIndex !== undefined ||
        selected.nativeTrack ||
        element?.readyState === 2),
  );
}
