export const CAPTION_STYLE_KEY = "lyra-caption-style";

export const CAPTION_STYLE_OPTIONS = {
  size: ["small", "medium", "large", "huge"],
  color: ["white", "yellow", "green", "cyan"],
  background: ["none", "dim", "dark", "solid"],
  edge: ["none", "shadow", "outline"],
} as const;

export type CaptionStyleName = keyof typeof CAPTION_STYLE_OPTIONS;
export type CaptionStyle = {
  [Name in CaptionStyleName]: (typeof CAPTION_STYLE_OPTIONS)[Name][number];
};

export const CAPTION_STYLE_NAMES = Object.keys(
  CAPTION_STYLE_OPTIONS,
) as CaptionStyleName[];

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  size: "medium",
  color: "white",
  background: "dark",
  edge: "shadow",
};

const SCALES: Record<CaptionStyle["size"], string> = {
  small: "0.8",
  medium: "1",
  large: "1.3",
  huge: "1.7",
};

const COLORS: Record<CaptionStyle["color"], string> = {
  white: "#fff",
  yellow: "#ffe45c",
  green: "#8dffa6",
  cyan: "#8df1ff",
};

const BACKGROUNDS: Record<CaptionStyle["background"], string> = {
  none: "transparent",
  dim: "rgb(0 0 0 / 0.45)",
  dark: "rgb(0 0 0 / 0.73)",
  solid: "#000",
};

const EDGES: Record<CaptionStyle["edge"], string> = {
  none: "none",
  shadow: "0 0.05em 0.1em #000",
  outline:
    "0.06em 0.06em 0 #000, -0.06em -0.06em 0 #000, 0.06em -0.06em 0 #000, -0.06em 0.06em 0 #000, 0 0 0.12em #000",
};

export function parseCaptionStyle(stored: string | null): CaptionStyle {
  const style = { ...DEFAULT_CAPTION_STYLE };
  if (!stored) return style;
  let saved: unknown;
  try {
    saved = JSON.parse(stored);
  } catch {
    return style;
  }
  if (!saved || typeof saved !== "object") return style;
  const values = style as Record<CaptionStyleName, string>;
  for (const name of CAPTION_STYLE_NAMES) {
    const value = (saved as Record<string, unknown>)[name];
    if ((CAPTION_STYLE_OPTIONS[name] as readonly unknown[]).includes(value)) {
      values[name] = value as string;
    }
  }
  return style;
}

export function readCaptionStyle(): CaptionStyle {
  try {
    return parseCaptionStyle(localStorage.getItem(CAPTION_STYLE_KEY));
  } catch {
    return { ...DEFAULT_CAPTION_STYLE };
  }
}

export function saveCaptionStyle(style: CaptionStyle): void {
  try {
    localStorage.setItem(CAPTION_STYLE_KEY, JSON.stringify(style));
  } catch {}
}

export function isDefaultCaptionStyle(style: CaptionStyle): boolean {
  return CAPTION_STYLE_NAMES.every(
    (name) => style[name] === DEFAULT_CAPTION_STYLE[name],
  );
}

export function captionStyleVariables(
  style: CaptionStyle,
): Record<string, string> {
  return {
    "--caption-scale": SCALES[style.size],
    "--caption-color": COLORS[style.color],
    "--caption-background": BACKGROUNDS[style.background],
    "--caption-shadow": EDGES[style.edge],
  };
}
