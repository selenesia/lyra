import { useEffect, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import type { ChatCosmeticSlot } from "./chatProtocol.ts";

interface CosmeticBase {
  id: string;
  name: string;
  category?: string;
  label?: string;
}

export interface CosmeticDecoration extends CosmeticBase {
  still: string;
  animated: string;
}

export interface CosmeticNameplate extends CosmeticBase {
  still: string;
  video: string;
  palette?: string;
}

export interface CosmeticEffectLayer {
  src: string;
  random?: string[];
  loop: boolean;
  start: number;
  duration: number;
  delay: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

export interface CosmeticEffect extends CosmeticBase {
  preview?: string;
  still?: string;
  layers: CosmeticEffectLayer[];
}

export interface CosmeticFrameLayer {
  src: string;
  kind: "staple" | "rail" | "border";
  front: boolean;
  anchor: "top" | "bottom" | "center";
  responsive: boolean;
}

export interface CosmeticFrame extends CosmeticBase {
  color?: string;
  inner: number;
  top: number;
  bottom: number;
  side: number;
  layers: CosmeticFrameLayer[];
}

export interface CosmeticItems {
  decoration: CosmeticDecoration;
  effect: CosmeticEffect;
  nameplate: CosmeticNameplate;
  frame: CosmeticFrame;
}

export type CosmeticItem = CosmeticItems[ChatCosmeticSlot];

interface CatalogPayload {
  version: string;
  categories: Array<{ id: string; name: string }>;
  decorations: CosmeticDecoration[];
  effects: CosmeticEffect[];
  nameplates: CosmeticNameplate[];
  frames: CosmeticFrame[];
}

export interface CosmeticCatalog {
  version: string;
  categories: ReadonlyMap<string, string>;
  lists: { [Slot in ChatCosmeticSlot]: readonly CosmeticItems[Slot][] };
  find<Slot extends ChatCosmeticSlot>(slot: Slot, id: string | null | undefined): CosmeticItems[Slot] | undefined;
}

export const NAMEPLATE_PALETTES: Readonly<Record<string, string>> = {
  crimson: "#e7040f",
  berry: "#b11fcf",
  sky: "#56ccff",
  teal: "#7deed7",
  forest: "#6aa624",
  bubble_gum: "#f957b3",
  violet: "#972fed",
  cobalt: "#4278ff",
  clover: "#63cd5a",
  lemon: "#fed400",
  white: "#ffffff",
  black: "#000000",
};

let catalog: CosmeticCatalog | null = null;
let loading: Promise<CosmeticCatalog | null> | null = null;
const listeners = new Set<(next: CosmeticCatalog) => void>();

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toCatalog(payload: CatalogPayload): CosmeticCatalog {
  const lists = {
    decoration: list<CosmeticDecoration>(payload.decorations),
    effect: list<CosmeticEffect>(payload.effects),
    nameplate: list<CosmeticNameplate>(payload.nameplates),
    frame: list<CosmeticFrame>(payload.frames),
  };
  const byId = {
    decoration: new Map(lists.decoration.map((item) => [item.id, item])),
    effect: new Map(lists.effect.map((item) => [item.id, item])),
    nameplate: new Map(lists.nameplate.map((item) => [item.id, item])),
    frame: new Map(lists.frame.map((item) => [item.id, item])),
  };
  return {
    version: payload.version,
    categories: new Map(list<{ id: string; name: string }>(payload.categories).map((category) => [category.id, category.name])),
    lists,
    find(slot, id) {
      return id ? (byId[slot].get(id) as CosmeticItems[typeof slot] | undefined) : undefined;
    },
  };
}

export function loadCosmetics(): Promise<CosmeticCatalog | null> {
  if (catalog) return Promise.resolve(catalog);
  loading ??= fetch(appPath("/!!cosmetics/catalog"))
    .then((response) => (response.ok ? (response.json() as Promise<CatalogPayload>) : null))
    .then((payload) => {
      if (!payload || typeof payload.version !== "string") return null;
      catalog = toCatalog(payload);
      for (const listener of listeners) listener(catalog);
      listeners.clear();
      return catalog;
    })
    .catch(() => null)
    .finally(() => {
      if (!catalog) loading = null;
    });
  return loading;
}

export function useCosmetics(wanted = true): CosmeticCatalog | null {
  const [current, setCurrent] = useState(catalog);
  useEffect(() => {
    if (!wanted) return;
    if (catalog) {
      setCurrent(catalog);
      return;
    }
    listeners.add(setCurrent);
    void loadCosmetics();
    return () => {
      listeners.delete(setCurrent);
    };
  }, [wanted]);
  return current;
}

export function cosmeticUrl(name: string): string {
  return appPath(`/!!cosmetics/a/${name}`);
}

const BLOB_LIMIT = 6;
interface CosmeticBlobEntry {
  blob: Promise<Blob | null>;
  controller: AbortController;
  holders: number;
  kept: boolean;
  settled: boolean;
}

const blobs = new Map<string, CosmeticBlobEntry>();

export function cosmeticBlob(name: string, signal?: AbortSignal): Promise<Blob | null> {
  let entry = blobs.get(name);
  if (entry) blobs.delete(name);
  else {
    const controller = new AbortController();
    const created: CosmeticBlobEntry = {
      controller,
      holders: 0,
      kept: false,
      settled: false,
      blob: fetch(cosmeticUrl(name), { signal: controller.signal })
        .then((response) => (response.ok ? response.blob() : null))
        .catch(() => null),
    };
    void created.blob.then((loaded) => {
      created.settled = true;
      if (!loaded && blobs.get(name) === created) blobs.delete(name);
    });
    entry = created;
  }
  blobs.set(name, entry);
  if (blobs.size > BLOB_LIMIT) blobs.delete(blobs.keys().next().value!);
  if (!signal) entry.kept = true;
  else if (!signal.aborted && !entry.settled) {
    const held = entry;
    held.holders++;
    signal.addEventListener("abort", () => {
      held.holders--;
      if (held.settled || held.kept || held.holders > 0) return;
      held.controller.abort();
      if (blobs.get(name) === held) blobs.delete(name);
    }, { once: true });
  }
  return entry.blob;
}

export function cosmeticMatches(item: CosmeticBase, query: string, categories: ReadonlyMap<string, string>): boolean {
  if (!query) return true;
  const category = item.category ? (categories.get(item.category) ?? "") : "";
  return `${item.name}\n${category}\n${item.label ?? ""}`.toLowerCase().includes(query);
}
