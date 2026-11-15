export interface ChatNameFont {
  id: string;
  label: string;
  family: string;
  fallback: string;
  weight: number;
  italic?: boolean;
  scale: number;
  tracking?: string;
}

export const CHAT_NAME_FONTS: readonly ChatNameFont[] = [
  { id: "default", label: "default", family: "Lexend", fallback: "sans-serif", weight: 400, scale: 1 },
  { id: "rounded", label: "bubbly", family: "Fredoka", fallback: "sans-serif", weight: 600, scale: 1.04 },
  { id: "modern", label: "wide", family: "Unbounded", fallback: "sans-serif", weight: 600, scale: 0.88 },
  { id: "chunky", label: "chunky", family: "Bungee", fallback: "sans-serif", weight: 400, scale: 0.84 },
  { id: "comic", label: "comic", family: "Bangers", fallback: "sans-serif", weight: 400, scale: 0.96, tracking: "0.04em" },
  { id: "groovy", label: "groovy", family: "Shrikhand", fallback: "serif", weight: 400, scale: 0.96 },
  { id: "script", label: "script", family: "Pacifico", fallback: "cursive", weight: 400, scale: 1 },
  { id: "handwritten", label: "marker", family: "Permanent Marker", fallback: "cursive", weight: 400, scale: 0.92 },
  { id: "serif", label: "elegant", family: "Playfair Display", fallback: "serif", weight: 700, italic: true, scale: 1.02 },
  { id: "royal", label: "royal", family: "Cinzel Decorative", fallback: "serif", weight: 700, scale: 0.82 },
  { id: "gothic", label: "gothic", family: "Grenze Gotisch", fallback: "serif", weight: 600, scale: 1.14 },
  { id: "spooky", label: "spooky", family: "Creepster", fallback: "cursive", weight: 400, scale: 0.92, tracking: "0.03em" },
  { id: "drip", label: "drip", family: "Rubik Wet Paint", fallback: "sans-serif", weight: 400, scale: 1 },
  { id: "broken", label: "broken", family: "Rubik Glitch", fallback: "sans-serif", weight: 400, scale: 1 },
  { id: "tube", label: "tube", family: "Tilt Neon", fallback: "sans-serif", weight: 400, scale: 1.02 },
  { id: "scifi", label: "sci-fi", family: "Orbitron", fallback: "sans-serif", weight: 600, scale: 0.9, tracking: "0.02em" },
  { id: "arcade", label: "arcade", family: "Audiowide", fallback: "sans-serif", weight: 400, scale: 0.94 },
  { id: "pixel", label: "pixel", family: "Pixelify Sans", fallback: "sans-serif", weight: 500, scale: 1.08 },
  { id: "terminal", label: "terminal", family: "VT323", fallback: "monospace", weight: 400, scale: 1.3 },
  { id: "mono", label: "mono", family: "Space Mono", fallback: "monospace", weight: 700, scale: 0.92 },
  { id: "typewriter", label: "typewriter", family: "Special Elite", fallback: "monospace", weight: 400, scale: 1.06 },
];

export const CHAT_NAME_EFFECTS = [
  { id: "none", label: "none" },
  { id: "glow", label: "glow" },
  { id: "neon", label: "neon" },
  { id: "shadow", label: "retro 3d" },
  { id: "gradient", label: "two-tone" },
  { id: "shimmer", label: "shimmer" },
  { id: "flow", label: "flow" },
  { id: "pulse", label: "pulse" },
  { id: "prism", label: "prism" },
  { id: "glitch", label: "glitch" },
  { id: "sparkle", label: "sparkle" },
] as const;

export const CHAT_NAME_MOVING_EFFECTS: ReadonlySet<string> = new Set(["shimmer", "flow", "pulse", "prism", "glitch", "sparkle"]);
const GRADIENT_EFFECTS: ReadonlySet<string> = new Set(["gradient", "shimmer", "flow"]);

export interface ChatNameColor {
  id: string;
  label: string;
  stops: readonly string[];
}

export const CHAT_NAME_SOLIDS: readonly ChatNameColor[] = [
  { id: "rose", label: "rose", stops: ["#ff8fb1", "#d3b4ff"] },
  { id: "crimson", label: "crimson", stops: ["#ff6b81", "#ffb38a"] },
  { id: "peach", label: "peach", stops: ["#ffb38a", "#ff99bb"] },
  { id: "gold", label: "gold", stops: ["#f3d37a", "#ffa380"] },
  { id: "lime", label: "lime", stops: ["#c6f36b", "#6be3c6"] },
  { id: "mint", label: "mint", stops: ["#88e1ba", "#8cceef"] },
  { id: "sky", label: "sky", stops: ["#8cceef", "#d3b4ff"] },
  { id: "ice", label: "ice", stops: ["#d6f3ff", "#9ec9ff"] },
  { id: "violet", label: "violet", stops: ["#d3b4ff", "#ff99bb"] },
];

export const CHAT_NAME_PALETTES: readonly ChatNameColor[] = [
  { id: "aurora", label: "aurora", stops: ["#7cf5c8", "#7ab8ff", "#c79bff"] },
  { id: "sunset", label: "sunset", stops: ["#ffd36e", "#ff8a6b", "#ff5fa2"] },
  { id: "candy", label: "candy", stops: ["#ff9ad5", "#b8a6ff", "#8fd8ff"] },
  { id: "ocean", label: "ocean", stops: ["#6ff0ff", "#5aa9ff", "#8d86ff"] },
  { id: "lava", label: "lava", stops: ["#ffe066", "#ff7a3d", "#ff4f7b"] },
  { id: "toxic", label: "toxic", stops: ["#e6ff5c", "#6bff8f", "#2ee6c8"] },
  { id: "galaxy", label: "galaxy", stops: ["#ff7cd0", "#a685ff", "#6f9bff"] },
  { id: "holo", label: "holo", stops: ["#ffc9f3", "#c2f0ff", "#fff1b3"] },
  { id: "chrome", label: "chrome", stops: ["#ffffff", "#aab4c4", "#eef2f8", "#b4bdcb"] },
  { id: "rainbow", label: "rainbow", stops: ["#ff7a7a", "#ffd36e", "#7dff9a", "#6fc8ff", "#c88bff"] },
];

const PRESET_COLORS = new Map([...CHAT_NAME_SOLIDS, ...CHAT_NAME_PALETTES].map((color) => [color.id, color]));
const PALETTE_IDS: ReadonlySet<string> = new Set(CHAT_NAME_PALETTES.map((color) => color.id));
const CUSTOM_COLOR = /^#[0-9a-f]{6}$/;

export const CHAT_NAME_STYLE_FIELDS = ["nameFont", "nameEffect", "nameColor"] as const;
export type ChatNameStyleField = (typeof CHAT_NAME_STYLE_FIELDS)[number];
export type ChatNameStyle = Partial<Record<ChatNameStyleField, string>>;
export type ChatNameStyleDraft = Partial<Record<ChatNameStyleField, string | null>>;

export function isCustomNameColor(value: unknown): value is string {
  return typeof value === "string" && CUSTOM_COLOR.test(value);
}

export function isChatNameStyle(field: ChatNameStyleField, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (field === "nameFont") return CHAT_NAME_FONTS.some((font) => font.id === value);
  if (field === "nameEffect") return CHAT_NAME_EFFECTS.some((effect) => effect.id === value);
  return value === "default" || PRESET_COLORS.has(value) || CUSTOM_COLOR.test(value);
}

export function chatNameFont(id: string | undefined): ChatNameFont {
  return CHAT_NAME_FONTS.find((font) => font.id === id) ?? CHAT_NAME_FONTS[0]!;
}

export function chatNameFontUrl(font: ChatNameFont): string {
  const family = font.family.replace(/ /g, "+");
  const axes = font.italic ? `:ital,wght@1,${font.weight}` : font.weight === 400 ? "" : `:wght@${font.weight}`;
  return `https://fonts.googleapis.com/css2?family=${family}${axes}&display=swap`;
}

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function prefersDarkText(colors: readonly string[]): boolean {
  const levels = colors.map((color) => luminance(hexToRgb(color)));
  const onLight = Math.min(...levels.map((level) => 1.05 / (level + 0.05)));
  const onDark = Math.min(...levels.map((level) => (level + 0.05) / 0.05));
  return onDark > onLight;
}

const MIN_NAME_LUMINANCE = 0.22;

export function readableNameColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (luminance(rgb) >= MIN_NAME_LUMINANCE) return hex;
  const gain = 255 / Math.max(1, ...rgb);
  const bright = rgb.map((channel) => channel * gain) as Rgb;
  const lift = (amount: number): Rgb =>
    amount <= 1
      ? (rgb.map((channel) => channel * (1 + (gain - 1) * amount)) as Rgb)
      : (bright.map((channel) => channel + (255 - channel) * (amount - 1)) as Rgb);
  let low = 0;
  let high = 2;
  for (let step = 0; step < 12; step += 1) {
    const middle = (low + high) / 2;
    if (luminance(lift(middle)) >= MIN_NAME_LUMINANCE) high = middle;
    else low = middle;
  }
  return rgbToHex(lift(high).map(Math.ceil) as Rgb);
}

export function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r / 255) hue = ((g - b) / 255 / delta) % 6;
    else if (max === g / 255) hue = (b - r) / 255 / delta + 2;
    else hue = (r - g) / 255 / delta + 4;
  }
  return [(hue * 60 + 360) % 360, max ? delta / max : 0, max];
}

export function hsvToRgb(hue: number, saturation: number, value: number): Rgb {
  const chroma = value * saturation;
  const side = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = value - chroma;
  const sector = Math.floor((((hue % 360) + 360) % 360) / 60);
  const [r, g, b] = [
    [chroma, side, 0],
    [side, chroma, 0],
    [0, chroma, side],
    [0, side, chroma],
    [side, 0, chroma],
    [chroma, 0, side],
  ][sector]!;
  return [(r! + base) * 255, (g! + base) * 255, (b! + base) * 255];
}

function companionColor(hex: string): string {
  const [hue, saturation, value] = rgbToHsv(hexToRgb(hex));
  return readableNameColor(rgbToHex(hsvToRgb(hue + 42, Math.max(saturation, 0.35), value)));
}

export interface ChatNameLook {
  font: ChatNameFont;
  effect: string;
  gradient: boolean;
  moving: boolean;
  vars: Record<string, string> | undefined;
}

const colorVars = new Map<string, Record<string, string> | undefined>();

function nameColorVars(color: string | undefined): Record<string, string> | undefined {
  if (!color || color === "default") return undefined;
  if (colorVars.has(color)) return colorVars.get(color);
  let vars: Record<string, string> | undefined;
  const preset = PRESET_COLORS.get(color);
  if (preset) {
    vars = { "--name-a": preset.stops[0]!, "--name-b": preset.stops[1]! };
    if (PALETTE_IDS.has(color)) vars["--name-stops"] = preset.stops.join(", ");
  } else if (CUSTOM_COLOR.test(color)) {
    const base = readableNameColor(color);
    vars = { "--name-a": base, "--name-b": companionColor(base) };
  }
  colorVars.set(color, vars);
  return vars;
}

export function chatNameLook(style: ChatNameStyle): ChatNameLook {
  const effect = isChatNameStyle("nameEffect", style.nameEffect) ? style.nameEffect : "none";
  const color = isChatNameStyle("nameColor", style.nameColor) ? style.nameColor : undefined;
  return {
    font: chatNameFont(style.nameFont),
    effect,
    gradient: GRADIENT_EFFECTS.has(effect) || (!!color && PALETTE_IDS.has(color)),
    moving: CHAT_NAME_MOVING_EFFECTS.has(effect),
    vars: nameColorVars(color),
  };
}

export function chatNameSwatch(color: string): string {
  const preset = PRESET_COLORS.get(color);
  if (preset && PALETTE_IDS.has(color)) return `linear-gradient(135deg, ${preset.stops.join(", ")})`;
  if (preset) return preset.stops[0]!;
  return CUSTOM_COLOR.test(color) ? readableNameColor(color) : "currentColor";
}
