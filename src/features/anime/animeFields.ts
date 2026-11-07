import { normalizeAnimeIds } from "./animeIdentity.ts";
import { normalizeCatalogText } from "../../core/media/catalogSearch.ts";
import type { AnimeEntryCategory, AnimeEntry } from "./anime.ts";

export function isAnimeMovieFormat(format?: string): boolean {
  const normalized = format?.trim().toUpperCase();
  return normalized === "MOVIE" || normalized === "MUSIC";
}

export function classifyAnimeCategory(
  format?: string,
  title = "",
  relationType?: string,
): AnimeEntryCategory {
  const normalizedFormat = format?.trim().toUpperCase();
  const normalizedTitle = title.toLocaleLowerCase();
  const normalizedRelation = relationType
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[-_]+/g, " ");

  if (normalizedFormat === "MOVIE") return "movie";
  if (normalizedFormat === "MUSIC") return "music";
  if (normalizedFormat === "OVA" || normalizedFormat === "OAD") return "ova";
  if (normalizedFormat === "ONA") return "ona";
  if (
    normalizedFormat === "SPECIAL" ||
    /\b(?:special|recap|summary|digest|kanwa)\b/.test(normalizedTitle)
  ) {
    return /\b(?:recap|summary|digest)\b/.test(normalizedTitle)
      ? "recap"
      : "special";
  }
  if (/\b(?:movie|gekijouban|film)\b/.test(normalizedTitle)) return "movie";
  if (/\b(?:ova|oad)\b/.test(normalizedTitle)) return "ova";
  if (/\bona\b/.test(normalizedTitle)) return "ona";
  if (normalizedRelation === "spin off") return "spin-off";
  if (normalizedRelation === "side story") return "side-story";
  if (normalizedFormat === "TV" || normalizedFormat === "TV_SHORT") {
    return "main-season";
  }
  if (normalizedRelation === "prequel" || normalizedRelation === "sequel") {
    return "main-season";
  }
  return "unknown";
}

export function normalizeAnimeRating(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const score = parsed > 10 ? parsed / 10 : parsed;
  if (!Number.isFinite(score) || score <= 0) return undefined;
  return Math.round(Math.min(10, score) * 10) / 10;
}

export function getAdultAllowed(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("animeAdultContent") === "true"
  );
}

export function getAudienceCacheKey(): string {
  return getAdultAllowed() ? "adult" : "safe";
}

export function applySearchFields(anime: AnimeEntry[]): AnimeEntry[] {
  for (const a of anime) {
    a.ids = normalizeAnimeIds({
      ...a.ids,
      anilistId: a.anilistId,
      malId: a.malId,
    });
    a._normalizedTitle = normalizeCatalogText(a.title || "");
    a._searchText ||= a._normalizedTitle;
  }
  return anime;
}
