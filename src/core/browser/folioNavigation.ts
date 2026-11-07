import { NEGATIVE } from "../runtime/messages.ts";
import { ensureProxyRuntime } from "../proxy/proxyRuntime.ts";
import { isCurrentNavigation } from "./navigationVersion.ts";

export function shouldRouteThroughFolio(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;
    if (parsed.origin === window.location.origin) return false;
    return true;
  } catch {
    return false;
  }
}

export async function waitForNavigationTransport(strict: boolean): Promise<void> {
  if (!window.Lyra?.waitForTransport) return;
  try {
    await window.Lyra.waitForTransport(8000);
  } catch (e: unknown) {
    console.warn(
      "iframe navigation: transport not ready; attempting recovery:",
      (e as Error).message,
      NEGATIVE,
    );
    const conn = (window as unknown as Record<string, unknown>)[
      "lyraConnection"
    ] as { recoverOnWake?: () => Promise<void> } | undefined;
    if (!conn?.recoverOnWake) {
      if (strict) throw e;
      return;
    }
    try {
      await conn.recoverOnWake();
      await window.Lyra.waitForTransport?.(6000);
    } catch (recoveryError) {
      if (!strict) {
        console.warn(
          "iframe navigation: recovery failed; continuing without recovery",
          NEGATIVE,
        );
        return;
      }
      console.warn(
        "iframe navigation: recovery failed before folio navigation",
        NEGATIVE,
      );
      throw recoveryError;
    }
  }
}

export async function navigateExternalThroughFolio(
  iframe: HTMLIFrameElement,
  url: string,
  version: number,
): Promise<void> {
  await ensureProxyRuntime();
  await waitForNavigationTransport(true);
  if (!isCurrentNavigation(iframe, version)) return;
  const folio = await import("../proxy/folio");
  await folio.navigateFolioIframe(iframe, url, () =>
    isCurrentNavigation(iframe, version),
  );
}
