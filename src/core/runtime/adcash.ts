export const ADCASH_LIBRARY_PATH = "/_app/core.js";

export function loadAdcash(origin = ""): void {
  const page = window as Window & { __lyraAdcashLoading?: boolean };
  if (page.top !== page.self || page.__lyraAdcashLoading) return;
  page.__lyraAdcashLoading = true;
  const library = document.createElement("script");
  library.async = true;
  library.src = origin + ADCASH_LIBRARY_PATH;
  document.head.appendChild(library);
}

export function adcashEmbedderPolicy(userAgent: string | null): "credentialless" | "require-corp" {
  const browser = /\b(Chrome|Firefox)\/(\d+)/.exec(userAgent || "");
  return browser && Number(browser[2]) >= (browser[1] === "Chrome" ? 96 : 119) ? "credentialless" : "require-corp";
}
