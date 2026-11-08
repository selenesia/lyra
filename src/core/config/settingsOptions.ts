export const DEFAULT_SETTINGS = {
  transport: "epoxy",
  searchEngine: "duckduckgo",
  gameSource: "truffled",
  theme: "default",
  siteCloaking: "coursera",
  linkCloaking: "none",
} as const;

export const TRANSPORT_OPTIONS = ["epoxy", "libcurl"] as const;
export const GAME_SOURCE_OPTIONS = [
  "truffled",
  "gn-math",
  "selenite",
  "edurocks",
  "wasm.rip",
] as const;
export const SITE_CLOAKING_OPTIONS = [
  "coursera",
  "none",
  "google",
  "google classroom",
  "google docs",
  "youtube",
  "google drive",
  "schoology",
  "wikipedia",
  "canva",
] as const;
export const LINK_CLOAKING_OPTIONS = ["none", "about:blank", "blob:"] as const;
export const THEME_OPTIONS = [
  "default",
  "catppuccin",
  "dracula",
  "synthwave",
  "tokyo night",
  "everforest",
  "kanagawa",
  "solarized",
  "sakura",
] as const;
export type ThemeKey = (typeof THEME_OPTIONS)[number];

function isThemeKey(value: string): value is ThemeKey {
  return (THEME_OPTIONS as readonly string[]).includes(value);
}

export function resolveTheme(value: string | null | undefined): ThemeKey {
  return value && isThemeKey(value) ? value : DEFAULT_SETTINGS.theme;
}

export type GameSourceKey = (typeof GAME_SOURCE_OPTIONS)[number];

function isGameSourceKey(value: string): value is GameSourceKey {
  return (GAME_SOURCE_OPTIONS as readonly string[]).includes(value);
}

export function resolveGameSource(
  value: string | null | undefined,
): GameSourceKey {
  return value && isGameSourceKey(value) ? value : DEFAULT_SETTINGS.gameSource;
}

export function getStoredGameSource(): GameSourceKey {
  try {
    return resolveGameSource(localStorage.getItem("gameSource"));
  } catch {
    return resolveGameSource(null);
  }
}
