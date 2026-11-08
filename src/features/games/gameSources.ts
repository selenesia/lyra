import {
  getProxyUrl,
  encodeMochiUrl,
  decodeUrl,
} from "../../core/runtime/utils";
import { negativeMessage } from "../../core/runtime/messages.ts";
import type { GameSourceKey } from "../../core/config/settingsOptions";

export type GameEntry = {
  id: string | number;
  name: string;
  author?: string;
  coverUrl: string;
  gameUrl: string;
  isExternal: boolean;
  featured: boolean;
  sourceKey: GameSourceKey;
  _searchText?: string;
  _normalizedName?: string;
  _normalizedAuthor?: string;
};

export type GameCatalogErrorKind =
  | "implementation"
  | "network"
  | "upstream-data"
  | "temporary-source"
  | "unavailable";

export class GameCatalogError extends Error {
  readonly kind: GameCatalogErrorKind;
  readonly source: GameSourceKey;
  readonly status?: number;
  readonly attempts?: number;

  constructor(
    message: string,
    options: {
      kind: GameCatalogErrorKind;
      source: GameSourceKey;
      status?: number;
      attempts?: number;
      cause?: unknown;
    },
  ) {
    super(negativeMessage(message), { cause: options.cause });
    this.name = "GameCatalogError";
    this.kind = options.kind;
    this.source = options.source;
    if (options.status !== undefined) this.status = options.status;
    if (options.attempts !== undefined) this.attempts = options.attempts;
  }
}

type UnknownRecord = Record<string, unknown>;
type GameSourceAdapter = {
  key: GameSourceKey;
  catalogUrl: string;
  parseResponse?: (
    body: string,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
  parse: (payload: unknown) => GameEntry[];
};

const SOURCE_ORIGINS = {
  selenite: "https://selenite.cc",
  edurocks: "https://d20q8iy6t6707a.cloudfront.net",
  "gn-math": "https://gn-math.dev",
  "wasm.rip": "https://wasm.rip",
  truffled: "https://truffled.lol",
} as const satisfies Record<GameSourceKey, string>;

const GN_MATH_COVER_ORIGIN =
  "https://cdn.jsdelivr.net/gh/freebuisness/covers@main";
const GN_MATH_HTML_ORIGIN = "https://cdn.jsdelivr.net/gh/freebuisness/html@main";
const EDUROCKS_CATALOG_URL = `${SOURCE_ORIGINS.edurocks}/index.html`;
const EDUROCKS_ASSET_MAX_BYTES = 4 * 1024 * 1024;
const EDUROCKS_PLAIN_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const EDUROCKS_FALLBACK_ENCODED_ALPHABET =
  "0547391826LHBYCGQMNWETRVKFUSODJAPIZXtfzwhjiuqnlobekgycavmxdprs";
const EDUROCKS_STRING_LITERAL = String.raw`"(?:\\.|[^"\\])*"`;
const EDUROCKS_SCALAR = String.raw`(?:${EDUROCKS_STRING_LITERAL}|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|![01]|true|false|null)`;
const EDUROCKS_VALUE = String.raw`(?:${EDUROCKS_SCALAR}|\[\s*(?:${EDUROCKS_SCALAR}(?:\s*,\s*${EDUROCKS_SCALAR})*)?\s*\])`;
const EDUROCKS_PROPERTY = String.raw`(${EDUROCKS_STRING_LITERAL}|[A-Za-z_$][\w$]*)\s*:\s*(${EDUROCKS_VALUE})`;
const EDUROCKS_ENTRY_PATTERN = new RegExp(
  String.raw`\{\s*${EDUROCKS_PROPERTY}(?:\s*,\s*${EDUROCKS_PROPERTY})*\s*,?\s*\}`,
  "g",
);
const EDUROCKS_MAIN_SCRIPT_PATTERN =
  /<script\b(?=[^>]*\btype=["']module["'])[^>]*\bsrc=["']([^"']+)["'][^>]*>/i;
const EDUROCKS_HOME_MODULE_PATTERN =
  /path\s*:\s*[A-Za-z_$][\w$]*\(\s*["']home["']\s*\)[\s\S]{0,500}?import\(\s*["'](\.\/[^"']+\.js)["']\s*\)/;
const EDUROCKS_CODE_ARRAY_PATTERN = /\[\s*((?:\d+\s*,\s*){61}\d+)\s*,?\s*\]/g;
const EDUROCKS_MODULE_REFERENCE_PATTERN =
  /(?:from\s*|import\(\s*)["'](\.\/[^"']+\.js)["']/g;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function identifier(value: unknown, fallback: string): string {
  return text(value) || fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

type EdurocksCatalogPayload = {
  body: string;
  encodedAlphabet: string;
};

function isEdurocksAlphabet(value: string): boolean {
  return (
    value.length === EDUROCKS_PLAIN_ALPHABET.length &&
    new Set(value).size === value.length &&
    [...value].every((character) => EDUROCKS_PLAIN_ALPHABET.includes(character))
  );
}

function findEdurocksEncodedAlphabet(value: string): string | null {
  let hasPlainAlphabet = false;
  let encodedAlphabet: string | null = null;
  for (const match of value.matchAll(EDUROCKS_CODE_ARRAY_PATTERN)) {
    const alphabet = String.fromCharCode(
      ...match[1]!.split(",").map((code) => Number(code)),
    );
    if (!isEdurocksAlphabet(alphabet)) continue;
    if (alphabet === EDUROCKS_PLAIN_ALPHABET) hasPlainAlphabet = true;
    else encodedAlphabet ??= alphabet;
  }
  return hasPlainAlphabet ? encodedAlphabet : null;
}

function edurocksDecodeMap(encodedAlphabet: string): Map<string, string> {
  const decodeMap = new Map<string, string>();
  for (let index = 0; index < encodedAlphabet.length; index += 1) {
    const encoded = encodedAlphabet[index];
    const plain = EDUROCKS_PLAIN_ALPHABET[index];
    if (encoded && plain) decodeMap.set(encoded, plain);
  }
  return decodeMap;
}

function decodeEdurocksText(
  value: string,
  decodeMap: ReadonlyMap<string, string>,
): string {
  let decoded = "";
  for (const character of value) {
    decoded += decodeMap.get(character) ?? character;
  }
  return decoded;
}

function decodeEdurocksStringLiteral(
  value: string | undefined,
  decodeMap: ReadonlyMap<string, string>,
): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string"
      ? decodeEdurocksText(parsed, decodeMap)
      : "";
  } catch {
    return "";
  }
}

function* edurocksEntries(value: string): Generator<Record<string, string>> {
  for (const entry of value.matchAll(EDUROCKS_ENTRY_PATTERN)) {
    const fields: Record<string, string> = Object.create(null);
    for (const property of entry[0].matchAll(new RegExp(EDUROCKS_PROPERTY, "g"))) {
      const key = property[1]!;
      fields[key.startsWith('"') ? JSON.parse(key) : key] = property[2]!;
    }
    if (
      fields.url?.startsWith('"') &&
      fields.name?.startsWith('"') &&
      fields.img?.startsWith('"') &&
      fields.id && Number.isFinite(Number(fields.id))
    ) {
      yield fields;
    }
  }
}

function containsEdurocksCatalog(value: string): boolean {
  return !edurocksEntries(value).next().done;
}

function edurocksModuleReferences(value: string): string[] {
  const references = new Set<string>();
  for (const match of value.matchAll(EDUROCKS_MODULE_REFERENCE_PATTERN)) {
    const reference = match[1];
    if (reference) references.add(reference);
  }
  return [...references];
}

type EdurocksAssetReference = {
  requestUrl: string;
  sourceUrl: string;
};

function resolveEdurocksAssetReference(
  reference: string,
  baseUrl: string,
): EdurocksAssetReference {
  if (reference.startsWith("/!!/")) {
    const sourceUrl = decodeUrl(reference);
    if (!sourceUrl.startsWith("http://") && !sourceUrl.startsWith("https://")) {
      throw new Error(
        negativeMessage("edurocks proxy asset url could not be decoded"),
      );
    }
    return { requestUrl: reference, sourceUrl };
  }
  const sourceUrl = new URL(reference, baseUrl).href;
  return { requestUrl: getProxyUrl(sourceUrl), sourceUrl };
}

async function fetchEdurocksAsset(
  asset: EdurocksAssetReference,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(asset.requestUrl, {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "text/html, text/javascript, application/javascript",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      negativeMessage(`edurocks asset request failed with ${response.status}`),
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > EDUROCKS_ASSET_MAX_BYTES
  ) {
    throw new Error(negativeMessage("edurocks asset response is too large"));
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > EDUROCKS_ASSET_MAX_BYTES) {
    throw new Error(negativeMessage("edurocks asset response is too large"));
  }
  return body;
}

async function findEdurocksCatalogModule(
  entryBody: string,
  entryUrl: string,
  signal: AbortSignal,
): Promise<EdurocksCatalogPayload | null> {
  const queue = [{ body: entryBody, url: entryUrl, depth: 0 }];
  const visited = new Set([entryUrl]);
  let catalogBody: string | null = null;
  let encodedAlphabet: string | null = null;
  let scanned = 0;

  while (queue.length > 0 && scanned < 40) {
    const module = queue.shift();
    if (!module) break;
    scanned += 1;
    catalogBody ||= containsEdurocksCatalog(module.body) ? module.body : null;
    encodedAlphabet ||= findEdurocksEncodedAlphabet(module.body);
    if (catalogBody && encodedAlphabet) {
      return { body: catalogBody, encodedAlphabet };
    }
    if (module.depth >= 2) continue;

    const references = edurocksModuleReferences(module.body).reverse();
    for (const reference of references) {
      const asset = resolveEdurocksAssetReference(reference, module.url);
      const url = asset.sourceUrl;
      if (visited.has(url)) continue;
      visited.add(url);
      const body = await fetchEdurocksAsset(asset, signal);
      queue.push({ body, url, depth: module.depth + 1 });
    }
  }
  return catalogBody
    ? {
        body: catalogBody,
        encodedAlphabet: encodedAlphabet ?? EDUROCKS_FALLBACK_ENCODED_ALPHABET,
      }
    : null;
}

async function resolveEdurocksCatalogResponse(
  body: string,
  signal: AbortSignal,
): Promise<EdurocksCatalogPayload> {
  if (containsEdurocksCatalog(body)) {
    return {
      body,
      encodedAlphabet: EDUROCKS_FALLBACK_ENCODED_ALPHABET,
    };
  }

  const mainReference = body.match(EDUROCKS_MAIN_SCRIPT_PATTERN)?.[1];
  if (!mainReference) {
    throw new Error(negativeMessage("edurocks main module was not found"));
  }
  const mainAsset = resolveEdurocksAssetReference(
    mainReference,
    EDUROCKS_CATALOG_URL,
  );
  const mainUrl = mainAsset.sourceUrl;
  const mainBody = await fetchEdurocksAsset(mainAsset, signal);

  const homeReference = mainBody.match(EDUROCKS_HOME_MODULE_PATTERN)?.[1];
  if (!homeReference) {
    throw new Error(negativeMessage("edurocks home module was not found"));
  }
  const homeAsset = resolveEdurocksAssetReference(homeReference, mainUrl);
  const homeUrl = homeAsset.sourceUrl;
  const homeBody = await fetchEdurocksAsset(homeAsset, signal);
  const catalog = await findEdurocksCatalogModule(homeBody, homeUrl, signal);
  if (!catalog) {
    throw new Error(negativeMessage("edurocks catalog module was not found"));
  }
  return catalog;
}

function arrayPayload(
  payload: unknown,
  source: GameSourceKey,
): UnknownRecord[] {
  if (!Array.isArray(payload)) {
    throw new GameCatalogError("catalog payload is not an array", {
      kind: "upstream-data",
      source,
    });
  }
  return payload.filter(isRecord);
}

function absoluteHttpUrl(value: unknown, origin: string): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function proxiedCoverUrl(
  value: unknown,
  origin: string,
  fallbackPath = "",
): string {
  const url = absoluteHttpUrl(value || fallbackPath, origin);
  return url ? `/!cover!/${encodeMochiUrl(url)}/` : "";
}

function mappedGame(
  sourceKey: GameSourceKey,
  value: {
    id: string | number;
    name: string;
    gameUrl: string;
    coverUrl?: string;
    author?: string;
    isExternal?: boolean;
    featured?: boolean;
  },
): GameEntry | null {
  if (!value.name || !value.gameUrl) return null;
  return {
    id: value.id,
    name: value.name,
    ...(value.author ? { author: value.author } : {}),
    coverUrl: value.coverUrl ?? "",
    gameUrl: value.gameUrl,
    isExternal: value.isExternal === true,
    featured: value.featured === true,
    sourceKey,
  };
}

function parseSelenite(payload: unknown): GameEntry[] {
  const rows = arrayPayload(payload, "selenite");
  return rows.flatMap((game) => {
    const directory = text(game.directory);
    const name = text(game.name);
    if (!directory || !name) return [];
    const gameUrl = `${SOURCE_ORIGINS.selenite}/resources/semag/${encodeURIComponent(directory)}`;
    const coverOrigin = `${SOURCE_ORIGINS.selenite}/resources/semag/${encodeURIComponent(directory)}/`;
    const coverUrl = proxiedCoverUrl(game.cover ?? game.image, coverOrigin);
    const mapped = mappedGame("selenite", {
      id: identifier(game.id, directory),
      name,
      gameUrl,
      coverUrl,
      author: text(game.author),
      featured: booleanValue(game.featured),
    });
    return mapped ? [mapped] : [];
  });
}

function parseEdurocks(payload: unknown): GameEntry[] {
  const body =
    typeof payload === "string"
      ? payload
      : isRecord(payload) && typeof payload.body === "string"
        ? payload.body
        : null;
  const encodedAlphabet =
    isRecord(payload) &&
    typeof payload.encodedAlphabet === "string" &&
    isEdurocksAlphabet(payload.encodedAlphabet)
      ? payload.encodedAlphabet
      : EDUROCKS_FALLBACK_ENCODED_ALPHABET;
  if (!body) {
    throw new GameCatalogError("catalog payload is not a js bundle", {
      kind: "upstream-data",
      source: "edurocks",
    });
  }

  const decodeMap = edurocksDecodeMap(encodedAlphabet);
  const games: GameEntry[] = [];
  for (const entry of edurocksEntries(body)) {
    const gameUrl = absoluteHttpUrl(
      decodeEdurocksStringLiteral(entry.url, decodeMap),
      SOURCE_ORIGINS.edurocks,
    );
    const name = decodeEdurocksStringLiteral(entry.name, decodeMap);
    const cover = decodeEdurocksStringLiteral(entry.img, decodeMap);
    const id = Number(entry.id);
    if (!gameUrl || !name || !Number.isFinite(id)) continue;

    const mapped = mappedGame("edurocks", {
      id,
      name,
      gameUrl,
      coverUrl: proxiedCoverUrl(cover, SOURCE_ORIGINS.edurocks),
    });
    if (mapped) games.push(mapped);
  }
  return games;
}

function parseWasmRip(payload: unknown): GameEntry[] {
  const rows = arrayPayload(payload, "wasm.rip");
  return rows.flatMap((game) => {
    const name = text(game.name);
    const gameUrl = absoluteHttpUrl(game.gameUrl, SOURCE_ORIGINS["wasm.rip"]);
    if (!name || !gameUrl) return [];
    const mapped = mappedGame("wasm.rip", {
      id: identifier(game.id, gameUrl),
      name,
      gameUrl,
      coverUrl: proxiedCoverUrl(game.imageUrl, SOURCE_ORIGINS["wasm.rip"]),
      author: text(game.author),
      featured: booleanValue(game.featured),
    });
    return mapped ? [mapped] : [];
  });
}

function parseGnMath(payload: unknown): GameEntry[] {
  const rows = arrayPayload(payload, "gn-math");
  return rows.flatMap((zone) => {
    const id = text(zone.id);
    const name = text(zone.name);
    if (!id || !name || name.includes("[!]") || name.startsWith("Chat Bot"))
      return [];

    const upstreamUrl = text(zone.url);
    const isExternal = Boolean(
      upstreamUrl && !upstreamUrl.includes("{HTML_URL}"),
    );
    const gameUrl = absoluteHttpUrl(
      upstreamUrl.replace("{HTML_URL}", GN_MATH_HTML_ORIGIN),
      SOURCE_ORIGINS["gn-math"],
    );
    if (!gameUrl) return [];

    const cover = text(zone.cover)
      .replace("{COVER_URL}", GN_MATH_COVER_ORIGIN)
      .replace("{HTML_URL}", GN_MATH_HTML_ORIGIN);
    const mapped = mappedGame("gn-math", {
      id,
      name,
      gameUrl,
      coverUrl: proxiedCoverUrl(cover, GN_MATH_COVER_ORIGIN),
      isExternal,
      author: text(zone.author),
      featured: booleanValue(zone.featured),
    });
    return mapped ? [mapped] : [];
  });
}

function parseTruffled(payload: unknown): GameEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.games)) {
    throw new GameCatalogError("catalog payload has no games array", {
      kind: "upstream-data",
      source: "truffled",
    });
  }

  return payload.games.filter(isRecord).flatMap((game) => {
    const name = text(game.name);
    const gameUrl = absoluteHttpUrl(game.url, SOURCE_ORIGINS.truffled);
    if (!name || !gameUrl) return [];
    const thumbnail = absoluteHttpUrl(game.thumbnail, SOURCE_ORIGINS.truffled);
    const mapped = mappedGame("truffled", {
      id: identifier(game.id, gameUrl),
      name,
      gameUrl,
      coverUrl: thumbnail ? getProxyUrl(thumbnail) : "",
      author: text(game.author),
      featured: booleanValue(game.featured),
    });
    return mapped ? [mapped] : [];
  });
}

export const GAME_SOURCE_ADAPTERS: Record<GameSourceKey, GameSourceAdapter> = {
  edurocks: {
    key: "edurocks",
    catalogUrl: getProxyUrl(EDUROCKS_CATALOG_URL),
    parseResponse: resolveEdurocksCatalogResponse,
    parse: parseEdurocks,
  },
  selenite: {
    key: "selenite",
    catalogUrl: getProxyUrl(`${SOURCE_ORIGINS.selenite}/resources/games.json`),
    parse: parseSelenite,
  },
  "gn-math": {
    key: "gn-math",
    catalogUrl: getProxyUrl(
      "https://cdn.jsdelivr.net/gh/freebuisness/assets@latest/zones.json",
    ),
    parse: parseGnMath,
  },
  "wasm.rip": {
    key: "wasm.rip",
    catalogUrl: getProxyUrl(`${SOURCE_ORIGINS["wasm.rip"]}/games.json`),
    parse: parseWasmRip,
  },
  truffled: {
    key: "truffled",
    catalogUrl: getProxyUrl(`${SOURCE_ORIGINS.truffled}/js/json/g.json`),
    parse: parseTruffled,
  },
};

export function parseGameCatalog(
  source: GameSourceKey,
  payload: unknown,
): GameEntry[] {
  const adapter = GAME_SOURCE_ADAPTERS[source];
  try {
    const games = adapter.parse(payload);
    if (games.length === 0) {
      throw new GameCatalogError("catalog contained no playable games", {
        kind: "upstream-data",
        source,
      });
    }
    const sorted = [...games].sort((left, right) =>
      source === "gn-math" && left.featured !== right.featured
        ? left.featured
          ? -1
          : 1
        : left.name.localeCompare(right.name),
    );
    return sorted;
  } catch (error) {
    if (error instanceof GameCatalogError) throw error;
    throw new GameCatalogError("catalog parsing failed", {
      kind: "implementation",
      source,
      cause: error,
    });
  }
}

export function gameCatalogErrorMessage(error: unknown): string {
  const kind =
    error instanceof GameCatalogError ? error.kind : "implementation";
  switch (kind) {
    case "network":
    case "temporary-source":
      return negativeMessage(
        "the game source is temporarily unreachable; try again shortly",
      );
    case "upstream-data":
      return negativeMessage(
        "the game source returned invalid game data; try another source",
      );
    case "unavailable":
      return negativeMessage(
        "this game source is currently unavailable; try another source",
      );
    default:
      return negativeMessage(
        "games could not be loaded right now; try again shortly",
      );
  }
}
