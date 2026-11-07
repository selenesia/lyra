export interface SyncMeta {
  dirty: boolean;
  last_synced: string | null;
  fingerprint?: string | null;
  changed_at?: number | null;
}

export const SYNC_META_KEY = "lyra-sync-meta";

export function revisionTime(revision: string): number {
  return Date.parse(revision.slice(0, 24));
}
