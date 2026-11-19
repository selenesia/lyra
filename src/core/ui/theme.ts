import type { ThemeKey } from "../config/settingsOptions.ts";
import { hexToRgb, isHexColor, luminance, prefersDarkText, rgbToHex, type Rgb } from "./color.ts";
import { motionDuration } from "./motion.ts";

const TRANSITION_CLASS = "theme-transitioning";

export const THEME_COLOR_STORAGE = {
  background: "lyra-theme-background",
  accent: "lyra-theme-accent",
} as const;

export type ThemeColorName = keyof typeof THEME_COLOR_STORAGE;
export type ThemeColors = Partial<Record<ThemeColorName, string>>;

const BACKGROUND_SURFACES: readonly [string, number][] = [
  ["--bg-body-grid", 9],
  ["--bg-surface-0", 0.4],
  ["--bg-surface-1", 2.4],
  ["--bg-surface-2", 3.7],
  ["--bg-surface-3", 4.9],
  ["--bg-surface-5", 7.3],
  ["--bg-surface-7", 9.8],
  ["--bg-surface-10", 13.5],
  ["--bg-surface-active", 18.8],
  ["--border-medium", 15.5],
  ["--split-border", 15.5],
  ["--split-divider-bg", 2],
  ["--input-bg", 7.8],
  ["--btn-secondary-bg", 8.6],
  ["--btn-secondary-bg-hover", 17],
  ["--checkbox-bg", 16.7],
  ["--search-inset-bg", 3.3],
  ["--search-inset-bg-focus", 4.9],
  ["--game-card-bg", 2.9],
  ["--skeleton-from", 2.9],
  ["--skeleton-via", 15],
  ["--skeleton-to", 2.9],
  ["--skeleton-alt-from", 3.3],
  ["--skeleton-alt-via", 7],
];

const ACCENT_SAME = [
  "--accent-color",
  "--border-focus",
  "--btn-primary-bg",
  "--checkbox-bg-checked",
  "--selection-bg",
  "--split-focus-border",
  "--color-link-hover",
] as const;

const ACCENT_INK = ["--btn-primary-text", "--selection-text"] as const;

const MAX_BACKGROUND_LUMINANCE = 0.03;

let activeTransition: ViewTransition | null = null;

export function applyTheme(theme: ThemeKey): void {
  const root = document.documentElement;
  if (theme === "default") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") ?? "default";
}

export function readableBackgroundColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (luminance(rgb) <= MAX_BACKGROUND_LUMINANCE) return hex;
  const scale = (amount: number) => rgb.map((channel) => channel * amount) as Rgb;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 14; step += 1) {
    const middle = (low + high) / 2;
    if (luminance(scale(middle)) <= MAX_BACKGROUND_LUMINANCE) low = middle;
    else high = middle;
  }
  return rgbToHex(scale(low).map(Math.floor) as Rgb);
}

export function readThemeColors(): ThemeColors {
  const colors: ThemeColors = {};
  for (const name of Object.keys(THEME_COLOR_STORAGE) as ThemeColorName[]) {
    try {
      const stored = localStorage.getItem(THEME_COLOR_STORAGE[name]);
      if (isHexColor(stored)) colors[name] = stored;
    } catch {
      return colors;
    }
  }
  return colors;
}

export function saveThemeColor(name: ThemeColorName, color: string | undefined): void {
  try {
    if (color) localStorage.setItem(THEME_COLOR_STORAGE[name], color);
    else localStorage.removeItem(THEME_COLOR_STORAGE[name]);
  } catch {
    return;
  }
}

function themeColorProperties({ background, accent }: ThemeColors): Map<string, string | null> {
  const properties = new Map<string, string | null>();
  const base = background ? readableBackgroundColor(background) : null;
  properties.set("--bg-body", base);
  for (const [property, amount] of BACKGROUND_SURFACES) {
    properties.set(property, base && `color-mix(in srgb, ${base}, var(--text-white) ${amount}%)`);
  }
  const ink = accent ? (prefersDarkText([accent]) ? "var(--text-black)" : "var(--text-white)") : null;
  for (const property of ACCENT_SAME) properties.set(property, accent ?? null);
  for (const property of ACCENT_INK) properties.set(property, ink);
  properties.set("--btn-primary-bg-hover", accent ? `color-mix(in srgb, ${accent}, #fff 20%)` : null);
  properties.set("--search-glow-border", accent ? `color-mix(in srgb, ${accent} 70%, transparent)` : null);
  properties.set("--search-glow-bg", accent ? `color-mix(in srgb, ${accent} 12%, transparent)` : null);
  properties.set("--split-indicator", accent ? `color-mix(in srgb, ${accent} 90%, transparent)` : null);
  return properties;
}

export function applyThemeColors(colors: ThemeColors): void {
  const style = document.documentElement.style;
  for (const [property, value] of themeColorProperties(colors)) {
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
  }
}

function transitionTheme(update: () => void): void {
  const duration = motionDuration("reveal");
  if (!document.startViewTransition || document.hidden || duration === 0) {
    activeTransition?.skipTransition();
    update();
    return;
  }

  activeTransition?.skipTransition();

  const root = document.documentElement;
  root.classList.add(TRANSITION_CLASS);
  const transition = document.startViewTransition(update);
  activeTransition = transition;

  transition.ready
    .then(() => {
      const radius = Math.hypot(window.innerWidth, window.innerHeight);
      root.animate(
        {
          clipPath: ["circle(0px at 0 0)", `circle(${radius}px at 0 0)`],
        },
        {
          duration,
          easing:
            getComputedStyle(root).getPropertyValue("--motion-ease").trim() ||
            "ease",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {});

  transition.finished.finally(() => {
    if (activeTransition !== transition) return;
    activeTransition = null;
    root.classList.remove(TRANSITION_CLASS);
  });
}

export function switchTheme(theme: ThemeKey): void {
  if (theme === currentTheme()) return;
  transitionTheme(() => applyTheme(theme));
}

export function switchThemeColors(colors: ThemeColors): void {
  transitionTheme(() => applyThemeColors(colors));
}
