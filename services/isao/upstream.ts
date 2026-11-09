import { LoadFailure } from "./cache.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const MAX_JSON_BYTES = 4 * 1024 * 1024;

export interface JsonRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface JsonResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export async function readLimited(response: Pick<Response, "headers" | "body">, limit = MAX_JSON_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw new LoadFailure("too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new LoadFailure("too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function requestJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  { method = "GET", headers = {}, body, timeoutMs = 10_000 }: JsonRequest = {},
): Promise<JsonResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await readLimited(response);
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LoadFailure("invalid_json");
      }
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  } catch (error) {
    if (error instanceof LoadFailure) throw error;
    throw new LoadFailure(controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  request: JsonRequest = {},
): Promise<T> {
  const result = await requestJson<T>(fetchImpl, url, request);
  if (result.status === 404) throw new LoadFailure("not_found");
  if (result.status < 200 || result.status >= 300) throw new LoadFailure(`status_${result.status}`);
  return result.body;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function integer(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

export function finite(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}
