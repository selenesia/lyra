import { appPath } from "../../core/runtime/hosting.ts";
import { prefersReducedMotion } from "../../core/config/advancedSettings.ts";
import { avatarColor, chatMediaUrl } from "./chatMedia.ts";
import { cosmeticBlob, cosmeticUrl, loadCosmetics } from "./chatCosmetics.ts";
import type { ChatMember, ChatProfile } from "./chatProtocol.ts";

const FRESH_MS = 15_000;
const PROFILE_LIMIT = 200;
const IMAGE_LIMIT = 48;
const HOVER_INTENT_MS = 120;
const OPEN_WAIT_MS = 250;

const profiles = new Map<string, { profile: ChatProfile; at: number }>();
const pending = new Map<string, Promise<ChatProfile | null>>();
const images = new Map<string, HTMLImageElement>();
let generation = 0;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function trim<K, V>(entries: Map<K, V>, limit: number) {
  while (entries.size > limit) entries.delete(entries.keys().next().value!);
}

export function cachedProfile(id: string): ChatProfile | undefined {
  return profiles.get(id)?.profile;
}

export function rememberProfile(profile: ChatProfile, at = Date.now()) {
  profiles.delete(profile.author);
  profiles.set(profile.author, { profile, at });
  trim(profiles, PROFILE_LIMIT);
}

export function patchProfile(card: ChatMember) {
  const known = profiles.get(card.author);
  if (known) rememberProfile({ ...known.profile, ...card }, 0);
}

export function forgetProfiles() {
  generation++;
  profiles.clear();
  pending.clear();
}

export function loadProfile(id: string, fresh = false): Promise<ChatProfile | null> {
  const known = profiles.get(id);
  if (!fresh && known && Date.now() - known.at < FRESH_MS) return Promise.resolve(known.profile);
  const inFlight = pending.get(id);
  if (!fresh && inFlight) return inFlight;
  const started = generation;
  const request = fetch(appPath(`/api/chat/profile?id=${encodeURIComponent(id)}`), { cache: "no-store" })
    .then(async (response) => (response.ok ? ((await response.json()) as { profile: ChatProfile }).profile : null))
    .catch(() => null)
    .then((profile) => {
      if (profile && started === generation) rememberProfile(profile);
      return profile;
    })
    .finally(() => {
      if (pending.get(id) === request) pending.delete(id);
    });
  pending.set(id, request);
  return request;
}

function warmImage(src: string): Promise<void> {
  let image = images.get(src);
  if (image) images.delete(src);
  else {
    image = new Image();
    image.decoding = "async";
    image.src = src;
  }
  images.set(src, image);
  trim(images, IMAGE_LIMIT);
  return image.decode().catch(() => {});
}

async function warmProfile(profile: ChatProfile): Promise<void> {
  const work: Array<Promise<unknown>> = [];
  if (profile.avatar) work.push(avatarColor(chatMediaUrl("avatar", profile.author, profile.avatar)));
  if (profile.banner) work.push(warmImage(chatMediaUrl("banner", profile.author, profile.banner)));
  const catalog = profile.decoration || profile.effect || profile.frame ? await loadCosmetics() : null;
  const decoration = catalog?.find("decoration", profile.decoration);
  if (decoration) work.push(warmImage(cosmeticUrl(prefersReducedMotion() ? decoration.still : decoration.animated)));
  for (const layer of catalog?.find("frame", profile.frame)?.layers ?? []) work.push(warmImage(cosmeticUrl(layer.src)));
  const effect = catalog?.find("effect", profile.effect);
  if (effect && prefersReducedMotion()) {
    if (effect.still) work.push(warmImage(cosmeticUrl(effect.still)));
  } else if (effect?.layers.length) {
    const first = Math.min(...effect.layers.map((layer) => layer.start));
    for (const layer of effect.layers) {
      if (layer.start !== first) continue;
      for (const name of layer.random?.length ? layer.random : [layer.src]) work.push(cosmeticBlob(name));
    }
  }
  await Promise.all(work);
}

function prepareProfile(id: string): Promise<void> {
  return loadProfile(id).then((profile) => (profile ? warmProfile(profile) : undefined));
}

export function prefetchProfile(id: string) {
  clearTimeout(hoverTimer);
  void prepareProfile(id);
}

export function readyProfile(id: string): Promise<void> {
  clearTimeout(hoverTimer);
  return Promise.race([prepareProfile(id), new Promise<void>((resolve) => setTimeout(resolve, OPEN_WAIT_MS))]);
}

export function profileIntent(id: string) {
  return {
    onPointerEnter: () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => void prepareProfile(id), HOVER_INTENT_MS);
    },
    onPointerLeave: () => clearTimeout(hoverTimer),
    onPointerDown: () => prefetchProfile(id),
    onFocus: () => prefetchProfile(id),
  };
}
