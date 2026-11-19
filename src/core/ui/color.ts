export type Rgb = [number, number, number];

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

export function luminance([r, g, b]: Rgb): number {
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
