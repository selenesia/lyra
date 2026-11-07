import {
  canSyncStorageValue,
  isLocalOnlySyncStorageKey,
  isSiteStorageName,
  isSensitiveSyncName,
  isSensitiveSyncText,
} from "./syncPolicy.ts";
import { hasOwn } from "./snapshotSchema.ts";

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function exportStorage(storage: StorageLike): Record<string, string> {
  const values: Record<string, string> = {};
  const keys = new Set<string>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null) keys.add(key);
  }
  for (const key of [...keys].sort()) {
    const value = storage.getItem(key);
    if (value !== null && canSyncStorageValue(key, value)) {
      values[key] = value;
    }
  }
  return values;
}

export function replaceStorage(
  storage: StorageLike,
  remote: Record<string, string>,
  includeSensitive: boolean,
): number {
  let changes = 0;
  const currentKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null) currentKeys.push(key);
  }
  for (const key of currentKeys) {
    if (isLocalOnlySyncStorageKey(key)) continue;
    const current = storage.getItem(key);
    const replaceSensitive = includeSensitive && isSiteStorageName(key);
    if (
      (replaceSensitive ||
        (!isSensitiveSyncName(key) &&
          !(current !== null && isSensitiveSyncText(current)))) &&
      !hasOwn(remote, key)
    ) {
      storage.removeItem(key);
      changes++;
    }
  }
  for (const [key, value] of Object.entries(remote)) {
    if (isLocalOnlySyncStorageKey(key) || storage.getItem(key) === value) {
      continue;
    }
    storage.setItem(key, value);
    changes++;
  }
  return changes;
}

export function applyStorageDelta(
  storage: StorageLike,
  previous: Record<string, string>,
  target: Record<string, string>,
): number {
  let changes = 0;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(target)])) {
    if (isLocalOnlySyncStorageKey(key)) continue;
    const next = hasOwn(target, key) ? target[key]! : null;
    const prior = hasOwn(previous, key) ? previous[key]! : null;
    if (next === prior || storage.getItem(key) === next) continue;
    if (next === null) storage.removeItem(key);
    else storage.setItem(key, next);
    changes++;
  }
  return changes;
}
