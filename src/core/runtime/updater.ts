import { negativeMessage } from "./messages.ts";

export { clientBuildId } from "./build.ts";

export type StuffResponse = {
  version: string;
  build?: string;
};

export type UpdateAttempt = {
  target: string;
  at: number;
  count: number;
};

export type UpdateState = {
  pending: string | null;
  attempt: UpdateAttempt | null;
  marker: string | null;
};

export type UpdateDecision =
  | { action: "none"; applied: boolean }
  | { action: "reload"; target: string; attempt: UpdateAttempt }
  | { action: "wait"; failed: boolean };

const UPDATE_PARAM = "update";
export const UPDATE_POLL_MS = 5 * 60 * 1000;
export const UPDATE_CHECK_THROTTLE_MS = 30 * 1000;
export const UPDATE_RETRY_MS = 5 * 60 * 1000;
export const UPDATE_RETRY_MAX_MS = 60 * 60 * 1000;

export function updateRetryDelay(count: number): number {
  return Math.min(
    UPDATE_RETRY_MS * 2 ** Math.max(0, count - 1),
    UPDATE_RETRY_MAX_MS,
  );
}

export function decideUpdate(
  metadata: StuffResponse,
  runningBuild: string,
  state: UpdateState,
  now = Date.now(),
): UpdateDecision {
  const target = metadata.build;
  if (!target || !runningBuild) return { action: "none", applied: false };
  if (target === runningBuild) {
    return {
      action: "none",
      applied: state.pending !== null || state.marker !== null,
    };
  }

  const previous = state.attempt?.target === target ? state.attempt : null;
  if (!previous) {
    if (state.marker === target) return { action: "wait", failed: true };
  } else if (
    previous.at <= now &&
    now - previous.at < updateRetryDelay(previous.count)
  ) {
    return { action: "wait", failed: state.marker === target };
  }

  return {
    action: "reload",
    target,
    attempt: { target, at: now, count: (previous?.count ?? 0) + 1 },
  };
}

export function parseUpdateAttempt(raw: string | null): UpdateAttempt | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { target, at, count } = value as Record<string, unknown>;
    if (
      typeof target !== "string" ||
      !target ||
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      return null;
    }
    return { target, at, count };
  } catch {
    return null;
  }
}

export function parseStuffResponse(input: unknown): StuffResponse {
  if (!input || typeof input !== "object") {
    throw new Error(negativeMessage("invalid /api/stuff response payload"));
  }

  const payload = input as Record<string, unknown>;
  if (typeof payload.version !== "string" || payload.version.length === 0) {
    throw new Error(
      negativeMessage(
        "invalid /api/stuff response: version must be a non-empty string",
      ),
    );
  }

  if (payload.build !== undefined && typeof payload.build !== "string") {
    throw new Error(
      negativeMessage(
        "invalid /api/stuff response: build must be a string when present",
      ),
    );
  }

  const parsed: StuffResponse = { version: payload.version };
  if (typeof payload.build === "string") parsed.build = payload.build;
  return parsed;
}

export function addUpdateMarker(href: string, target: string): string {
  const url = new URL(href);
  url.searchParams.set(UPDATE_PARAM, target);
  return url.href;
}

export function readUpdateMarker(href: string): string | null {
  return new URL(href).searchParams.get(UPDATE_PARAM);
}

export function removeUpdateMarker(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(UPDATE_PARAM);
  return url.href;
}
