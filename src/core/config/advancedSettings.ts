export const ADVANCED_SETTING_KEYS = {
  saveHistory: "saveBrowsingHistory",
  preloadProxy: "preloadProxyRuntime",
  motion: "motionPreference",
  fallingLeaves: "fallingLeaves",
} as const;

const DEFAULT_ADVANCED_SETTINGS = {
  saveHistory: true,
  preloadProxy: true,
  fallingLeaves: true,
  motion: "system",
} as const;

export const MOTION_OPTIONS = ["system", "reduced", "full"] as const;
export type MotionPreference = (typeof MOTION_OPTIONS)[number];
export type AdvancedToggle = "saveHistory" | "preloadProxy" | "fallingLeaves";

type StorageReader = Pick<Storage, "getItem">;

export function readAdvancedToggle(
  name: AdvancedToggle,
  storage?: StorageReader,
): boolean {
  try {
    const stored = (storage ?? localStorage).getItem(
      ADVANCED_SETTING_KEYS[name],
    );
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {}
  return DEFAULT_ADVANCED_SETTINGS[name];
}

function resolveMotionPreference(
  value: string | null | undefined,
): MotionPreference {
  return MOTION_OPTIONS.includes(value as MotionPreference)
    ? (value as MotionPreference)
    : DEFAULT_ADVANCED_SETTINGS.motion;
}

export function readMotionPreference(
  storage?: StorageReader,
): MotionPreference {
  try {
    return resolveMotionPreference(
      (storage ?? localStorage).getItem(ADVANCED_SETTING_KEYS.motion),
    );
  } catch {
    return DEFAULT_ADVANCED_SETTINGS.motion;
  }
}

export function applyMotionPreference(
  preference: MotionPreference,
  root: Pick<HTMLElement, "dataset"> = document.documentElement,
): void {
  root.dataset.motion = resolveMotionPreference(preference);
}

export function prefersReducedMotion(
  preference: MotionPreference = readMotionPreference(),
  systemPreference = typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
): boolean {
  if (preference === "reduced") return true;
  if (preference === "full") return false;
  return systemPreference;
}
