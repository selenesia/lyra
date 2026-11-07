import {
  type AnimeIds,
  normalizeAnimeIds,
  mergeAnimeIds,
} from "./animeIdentity.ts";
import { normalizeCatalogText } from "../../core/media/catalogSearch.ts";
import { applySearchFields } from "./animeFields.ts";
import type { AnimeEntry } from "./anime.ts";

function formatsCanShareTitle(left?: string, right?: string): boolean {
  const a = left?.toUpperCase();
  const b = right?.toUpperCase();
  if (!a || !b || a === b) return true;
  return [a, b].every((format) => format === "TV" || format === "TV_SHORT");
}

export function seasonNumberFromTitle(title: string): number | undefined {
  const match = title.match(
    /(?:season|series)\s+(\d+)|\b(\d+)(?:st|nd|rd|th)\s+season\b/i,
  );
  const explicitNumber = Number(match?.[1] || match?.[2]);
  if (Number.isInteger(explicitNumber) && explicitNumber > 0) {
    return explicitNumber;
  }

  if (/\b(?:part|cour)\s*\d+\b/i.test(title)) return undefined;

  const trailingNumber = title.match(/\s([2-9]|1[0-2])\s*$/i);
  const number = Number(trailingNumber?.[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

const SEASON_ID_PROVIDERS = [
  "mal",
  "anilist",
  "kitsu",
  "anidb",
  "anikoto",
] as const;

function conflictingSeasonIds(left: AnimeIds, right: AnimeIds): boolean {
  return SEASON_ID_PROVIDERS.some(
    (provider) =>
      left[provider] && right[provider] && left[provider] !== right[provider],
  );
}

function sharedProviderIdentity(left: AnimeEntry, right: AnimeEntry): boolean {
  const leftIds = normalizeAnimeIds({
    ...left.ids,
    anilistId: left.anilistId,
    malId: left.malId,
  });
  const rightIds = normalizeAnimeIds({
    ...right.ids,
    anilistId: right.anilistId,
    malId: right.malId,
  });
  if (conflictingSeasonIds(leftIds, rightIds)) return false;
  return SEASON_ID_PROVIDERS.some(
    (provider) => leftIds[provider] && leftIds[provider] === rightIds[provider],
  );
}

function metadataRank(entry: AnimeEntry): number {
  return { jikan: 4, anilist: 3, kitsu: 2, anikoto: 1 }[
    entry._metadataSource || "anikoto"
  ];
}

function mergeSeasonMetadata(existing: AnimeEntry, incoming: AnimeEntry): void {
  const preferIncoming = metadataRank(incoming) > metadataRank(existing);
  if (preferIncoming || existing.year == null)
    existing.year = incoming.year ?? existing.year;
  if (preferIncoming || !existing.format)
    existing.format = incoming.format || existing.format;
  if (preferIncoming) {
    existing.title = incoming.title;
    existing.category = incoming.category;
    existing._metadataSource = incoming._metadataSource;
  }
}

function mergeEpisodeCount(
  existing: AnimeEntry,
  incoming: AnimeEntry,
  incomingIds: AnimeIds,
): void {
  const incomingCount = incoming.episodeCount;
  if (!Number.isInteger(incomingCount) || !incomingCount || incomingCount < 1)
    return;
  const existingCount = existing.episodeCount || 0;
  const incomingSource =
    incoming._episodeCountSource ||
    (incomingIds.anikoto ? "anikoto" : undefined);
  const existingRank = episodeCountSourceRank(existing._episodeCountSource);
  const incomingRank = episodeCountSourceRank(incomingSource);
  if (!existingCount || incomingRank > existingRank) {
    existing.episodeCount = incomingCount;
    existing._episodeCountSource = incomingSource;
    return;
  }
  if (incomingRank === existingRank) {
    existing.episodeCount = Math.max(existingCount, incomingCount);
  }
}

function episodeCountSourceRank(
  source: AnimeEntry["_episodeCountSource"],
): number {
  if (source === "jikan") return 6;
  if (source === "anilist") return 5;
  if (source === "kitsu") return 4;
  if (source === "anikoto") return 3;
  if (source === "anilistAiring") return 2;
  if (source === "anikotoAiring") return 1;
  return 0;
}

export function mergeAnimeEntries(
  ...groups: ReadonlyArray<AnimeEntry>[]
): AnimeEntry[] {
  const entries: AnimeEntry[] = [];
  for (const entry of groups.flat()) {
    const ids = normalizeAnimeIds({
      ...entry.ids,
      anilistId: entry.anilistId,
      malId: entry.malId,
    });
    const existing = entries.find(
      (candidate) =>
        sharedProviderIdentity(candidate, entry) ||
        (normalizeCatalogText(candidate.title) ===
          normalizeCatalogText(entry.title) &&
          formatsCanShareTitle(candidate.format, entry.format) &&
          !conflictingSeasonIds(candidate.ids || {}, ids) &&
          (candidate.year || 0) === (entry.year || 0)),
    );
    if (!existing) {
      const individual = { ...entry, ids };
      delete individual.seasons;
      entries.push(individual);
      continue;
    }
    mergeEpisodeCount(existing, entry, ids);
    existing.ids = mergeAnimeIds(existing.ids, ids);
    existing._searchText = normalizeCatalogText(
      [existing._searchText, existing.title, entry._searchText, entry.title]
        .filter(Boolean)
        .join(" "),
    );
    mergeSeasonMetadata(existing, entry);
    existing.anilistId ||= ids.anilist ? Number(ids.anilist) : undefined;
    existing.malId ||= ids.mal ? Number(ids.mal) : undefined;
    existing.posterUrl ||= entry.posterUrl;
    existing.posterSmallUrl ||= entry.posterSmallUrl;
    existing.backdropUrl ||= entry.backdropUrl;
    existing.rating ??= entry.rating;
  }
  return applySearchFields(entries);
}
