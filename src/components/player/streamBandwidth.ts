import type { HlsConfig } from "hls.js";

const BANDWIDTH_KEY = "lyra-stream-bandwidth";
const MIN_BANDWIDTH = 500_000;
const MAX_BANDWIDTH = 200_000_000;

export function usableBandwidth(value: unknown): number | null {
  const bandwidth = Number(value);
  return Number.isFinite(bandwidth) && bandwidth >= MIN_BANDWIDTH
    ? Math.min(MAX_BANDWIDTH, Math.round(bandwidth))
    : null;
}

export function measuredBandwidthConfig(): Partial<HlsConfig> {
  try {
    const bandwidth = usableBandwidth(sessionStorage.getItem(BANDWIDTH_KEY));
    return bandwidth === null ? {} : { abrEwmaDefaultEstimate: bandwidth };
  } catch {
    return {};
  }
}

export function rememberBandwidth(estimate: number): void {
  const bandwidth = usableBandwidth(estimate);
  if (bandwidth === null) return;
  try {
    sessionStorage.setItem(BANDWIDTH_KEY, String(bandwidth));
  } catch {}
}
