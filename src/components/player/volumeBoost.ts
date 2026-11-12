export const VOLUME_STORAGE_KEY = "lyra-anime-volume";
export const VOLUME_LEVEL_MAX = 300;
export const VOLUME_SLIDER_MAX = 200;

const LIMITER = {
  threshold: -3,
  knee: 3,
  ratio: 20,
  attack: 0.003,
  release: 0.25,
} as const;
const GAIN_SMOOTHING_SECONDS = 0.015;

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext || scope.webkitAudioContext || null;
}

export function volumeBoostSupported(): boolean {
  return audioContextConstructor() !== null;
}

export function clampVolumeLevel(level: number, boostable: boolean): number {
  if (!Number.isFinite(level)) return 100;
  return Math.max(0, Math.min(boostable ? VOLUME_LEVEL_MAX : 100, level));
}

export function sliderToVolumeLevel(position: number): number {
  const clamped = Math.max(0, Math.min(VOLUME_SLIDER_MAX, position));
  return clamped <= 100 ? clamped : 100 + (clamped - 100) * 2;
}

export function volumeLevelToSlider(level: number): number {
  const clamped = Math.max(0, Math.min(VOLUME_LEVEL_MAX, level));
  return clamped <= 100 ? clamped : 100 + (clamped - 100) / 2;
}

export function readStoredVolumeLevel(boostable: boolean): number {
  try {
    const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
    return stored === null ? 100 : clampVolumeLevel(Number(stored), boostable);
  } catch {
    return 100;
  }
}

export function storeVolumeLevel(level: number): void {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(Math.round(level)));
  } catch {}
}

function configureLimiter(limiter: DynamicsCompressorNode): void {
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
}

async function measureLimiterTrim(): Promise<number> {
  const Offline =
    typeof OfflineAudioContext === "undefined" ? null : OfflineAudioContext;
  if (!Offline) return 1;
  const sampleRate = 44_100;
  const frames = sampleRate / 2;
  const amplitude = 0.01;
  const offline = new Offline(1, frames, sampleRate);
  const tone = offline.createOscillator();
  tone.frequency.value = 1_000;
  const level = offline.createGain();
  level.gain.value = amplitude;
  const limiter = offline.createDynamicsCompressor();
  configureLimiter(limiter);
  tone.connect(level).connect(limiter).connect(offline.destination);
  tone.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  let peak = 0;
  for (let index = frames >> 1; index < frames; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  }
  const makeup = peak / amplitude;
  return Number.isFinite(makeup) && makeup > 0.5 && makeup < 8 ? 1 / makeup : 1;
}

export interface VolumeBoost {
  setLevel(level: number): void;
  destroy(): void;
}

export function createVolumeBoost(video: HTMLMediaElement): VolumeBoost {
  let context: AudioContext | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let trim: GainNode | null = null;
  let trimValue: number | null = null;
  let boosted = false;
  let target = 1;
  let destroyed = false;

  const route = () => {
    if (!context || !source || !gain) return;
    const wanted = target > 1 && trimValue !== null;
    gain.gain.setTargetAtTime(
      wanted ? target : 1,
      context.currentTime,
      GAIN_SMOOTHING_SECONDS,
    );
    if (wanted === boosted) return;
    boosted = wanted;
    source.disconnect();
    source.connect(wanted ? gain : context.destination);
  };

  const connect = () => {
    if (destroyed || !context || source || context.state !== "running") return;
    try {
      source = context.createMediaElementSource(video);
    } catch {
      return;
    }
    gain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    configureLimiter(limiter);
    trim = context.createGain();
    trim.gain.value = trimValue ?? 1;
    gain.connect(limiter).connect(trim).connect(context.destination);
    source.connect(context.destination);
    route();
  };

  const resume = () => {
    if (destroyed || !context || context.state === "running") return;
    void context.resume().catch(() => {});
  };

  const start = () => {
    const Context = audioContextConstructor();
    if (context || !Context) return;
    try {
      context = new Context();
    } catch {
      context = null;
      return;
    }
    context.addEventListener("statechange", () => {
      if (context?.state === "running") connect();
    });
    for (const event of ["pointerdown", "keydown"] as const) {
      window.addEventListener(event, resume, { capture: true, passive: true });
    }
    video.addEventListener("play", resume);
    document.addEventListener("visibilitychange", resume);
    void measureLimiterTrim()
      .catch(() => 1)
      .then((value) => {
        trimValue = value;
        if (trim) trim.gain.value = value;
        route();
      });
    resume();
    connect();
  };

  return {
    setLevel(level) {
      if (destroyed) return;
      target = Math.max(1, clampVolumeLevel(level, true) / 100);
      if (target > 1) start();
      resume();
      route();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const event of ["pointerdown", "keydown"] as const) {
        window.removeEventListener(event, resume, { capture: true });
      }
      video.removeEventListener("play", resume);
      document.removeEventListener("visibilitychange", resume);
      if (source && context && boosted) {
        try {
          source.disconnect();
          source.connect(context.destination);
        } catch {}
      }
    },
  };
}
