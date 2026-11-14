import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { CHAT_GIF_COMMAND } from "./chatProtocol.ts";

export interface ChatGif {
  id: string;
  title: string;
  width: number;
  height: number;
}

export interface ChatGifResults {
  gifs: ChatGif[];
  loading: boolean;
  error: string | null;
  more: boolean;
  loadMore: () => void;
}

interface GifPage {
  query: string | undefined;
  gifs: ChatGif[];
  next: number | null;
  loading: boolean;
  error: string | null;
}

const SEARCH_DELAY_MS = 300;
const EMPTY: GifPage = { query: undefined, gifs: [], next: null, loading: false, error: null };
const GIF_ERRORS: Record<string, string> = {
  CHAT_RATE_LIMITED: "slow down a little",
  CHAT_GIF_NOT_FOUND: "that gif is gone",
  CHAT_GIF_TOO_LARGE: "that gif is too large to send",
  CHAT_GIF_INVALID: "that gif could not be used",
};

function gifError(code: unknown): string {
  return negativeMessage((typeof code === "string" && GIF_ERRORS[code]) || "gifs are unavailable right now");
}

export function gifQuery(draft: string): string | undefined {
  return CHAT_GIF_COMMAND.test(draft) ? draft.replace(CHAT_GIF_COMMAND, "").trim() : undefined;
}

export function chatGifUrl(id: string, size: "preview" | "full"): string {
  return appPath(`/api/chat/gifs/${encodeURIComponent(id)}?size=${size}`);
}

function readGifs(value: unknown): ChatGif[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (gif): gif is ChatGif =>
      !!gif && typeof gif.id === "string" && typeof gif.title === "string" && gif.width > 0 && gif.height > 0,
  );
}

async function fetchPage(query: string, page: number, signal: AbortSignal): Promise<{ gifs: ChatGif[]; next: number | null } | { error: string }> {
  try {
    const params = new URLSearchParams({ q: query, page: String(page) });
    const response = await fetch(appPath(`/api/chat/gifs?${params}`), { cache: "no-store", signal });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { error: gifError(body.code) };
    return { gifs: readGifs(body.gifs), next: typeof body.next === "number" ? body.next : null };
  } catch (error) {
    if (signal.aborted) throw error;
    return { error: gifError(undefined) };
  }
}

export async function fetchChatGif(id: string): Promise<{ blob: Blob } | { error: string }> {
  try {
    const response = await fetch(chatGifUrl(id, "full"));
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { error: gifError(body.code) };
    }
    const blob = await response.blob();
    return blob.type === "image/gif" ? { blob } : { error: gifError("CHAT_GIF_INVALID") };
  } catch {
    return { error: gifError(undefined) };
  }
}

export function useChatGifs(query: string | undefined): ChatGifResults {
  const [state, setState] = useState<GifPage>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    if (query === undefined) {
      controllerRef.current = null;
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const timer = setTimeout(() => {
      setState((current) => ({ query, gifs: current.query === query ? current.gifs : [], next: null, loading: true, error: null }));
      void fetchPage(query, 1, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          setState("error" in result
            ? { query, gifs: [], next: null, loading: false, error: result.error }
            : { query, gifs: result.gifs, next: result.next, loading: false, error: null });
        },
        () => undefined,
      );
    }, query ? SEARCH_DELAY_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    const controller = controllerRef.current;
    if (current.query !== query || current.loading || current.next === null || !controller || controller.signal.aborted) return;
    const page = current.next;
    setState({ ...current, loading: true });
    void fetchPage(current.query ?? "", page, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setState((latest) => {
          if (latest.query !== current.query) return latest;
          if ("error" in result) return { ...latest, loading: false, next: null };
          const known = new Set(latest.gifs.map((gif) => gif.id));
          return { ...latest, gifs: [...latest.gifs, ...result.gifs.filter((gif) => !known.has(gif.id))], next: result.next, loading: false };
        });
      },
      () => undefined,
    );
  }, [query]);

  if (query === undefined) return { gifs: [], loading: false, error: null, more: false, loadMore };
  const current = state.query === query;
  return {
    gifs: state.gifs,
    loading: !current || state.loading,
    error: current ? state.error : null,
    more: current && state.next !== null,
    loadMore,
  };
}
