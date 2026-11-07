import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { blockedNotice, isModerationCategory } from "./moderation.ts";
import type { ChatRole } from "./chatRoles.ts";
import { mentionsName } from "./chatText.ts";
import {
  CHAT_CHANNELS,
  CHAT_LIMITS,
  type ChatChannel,
  type ChatMediaKind,
  type ChatMember,
  type ChatMessage,
  type ChatProfile,
  type ChatTyping,
  type ChatViewer,
  isChatMediaKind,
} from "./chatProtocol.ts";

export interface ChatEntry extends ChatMessage {
  pending?: boolean;
}

export type ChatStatus = "connecting" | "live" | "offline";
export type ChatAccess =
  | { state: "checking" }
  | { state: "signedOut" }
  | { state: "banned"; until?: number; reason?: string }
  | { state: "usernameBlocked" }
  | { state: "unavailable" }
  | { state: "ready" };
export type ChatHistory = Record<ChatChannel, ChatEntry[]>;
export type ChatUnread = Partial<Record<ChatChannel, { count: number; mention: boolean }>>;

export interface ChatFailure {
  error: string;
  until?: number;
}

export type ChatResult = { message?: ChatMessage; profile?: ChatProfile; failure?: ChatFailure; removed?: number };
export type ChatModeration = "role" | "timeout" | "untimeout" | "ban" | "unban" | "clearprofile";
export type ChatProfileEdit = Partial<Record<"display" | "pronouns" | "status" | "bio", string | null>> &
  Partial<Record<ChatMediaKind, null>>;

const PROFILE_FIELD_LABELS: Record<string, string> = {
  display: "display name",
  pronouns: "pronouns",
  status: "status",
  bio: "about me",
};

const BLOCKED_STORAGE = "lyra-chat-blocked";
const VISIBLE_LIMIT = 400;
const TYPING_MS = 4_000;
const BACKGROUND_RELEASE_MS = 5_000;

function readBlocked(): ChatMember[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BLOCKED_STORAGE) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is ChatMember => typeof entry?.author === "string" && typeof entry?.name === "string")
      : [];
  } catch {
    return [];
  }
}

function withCard<T extends ChatMember | ChatMessage>(entry: T, card: ChatMember, keys: ReadonlyArray<"display" | "avatar" | "status">): T {
  const next: Partial<Record<"display" | "avatar" | "status", string>> = { ...entry };
  for (const key of keys) {
    const value = card[key];
    if (value) next[key] = value;
    else delete next[key];
  }
  return next as T;
}

function useForegroundTab(): boolean {
  const [foreground, setForeground] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    let release: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(release);
      if (document.visibilityState !== "hidden") setForeground(true);
      else release = setTimeout(() => setForeground(false), BACKGROUND_RELEASE_MS);
    };
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(release);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return foreground;
}

function newestId(entries: ChatEntry[]): number {
  let newest = 0;
  for (const entry of entries) if (!entry.pending) newest = Math.max(newest, Number(entry.id) || 0);
  return newest;
}

function emptyHistory(): ChatHistory {
  return Object.fromEntries(CHAT_CHANNELS.map((channel) => [channel, []])) as unknown as ChatHistory;
}

function emptyFlags(): Record<ChatChannel, boolean> {
  return Object.fromEntries(CHAT_CHANNELS.map((channel) => [channel, false])) as Record<ChatChannel, boolean>;
}

function upsert(entries: ChatEntry[], message: ChatEntry): ChatEntry[] {
  const existing = entries.findIndex(
    (entry) => entry.id === message.id || (!!message.nonce && entry.pending && entry.nonce === message.nonce),
  );
  if (existing >= 0) {
    if (entries[existing]!.id === message.id && !entries[existing]!.pending && message.pending) return entries;
    const next = entries.slice();
    next[existing] = message;
    return next;
  }
  return [...entries, message].slice(-VISIBLE_LIMIT);
}

function patchChannel(history: ChatHistory, channel: ChatChannel, update: (entries: ChatEntry[]) => ChatEntry[]): ChatHistory {
  const next = update(history[channel]);
  return next === history[channel] ? history : { ...history, [channel]: next };
}

function accessFrom(status: number, body: Record<string, unknown>): ChatAccess {
  if (status === 200) return { state: "ready" };
  if (body.code === "CHAT_LOGIN_REQUIRED") return { state: "signedOut" };
  if (body.code === "CHAT_USERNAME_BLOCKED") return { state: "usernameBlocked" };
  if (body.code === "CHAT_BANNED") {
    return {
      state: "banned",
      ...(typeof body.until === "number" && { until: body.until }),
      ...(typeof body.reason === "string" && { reason: body.reason }),
    };
  }
  return { state: "unavailable" };
}

function describeFailure(code: unknown, body: Record<string, unknown>): ChatFailure {
  const until = typeof body.until === "number" ? body.until : undefined;
  const category = isModerationCategory(body.category) ? body.category : undefined;
  const blockedText = (subject: string) =>
    category ? blockedNotice(subject, category) : `that ${subject} was blocked for breaking the rules`;
  const field = typeof body.field === "string" ? PROFILE_FIELD_LABELS[body.field] : undefined;
  const failure = (error: string): ChatFailure => ({
    error: negativeMessage(error),
    ...(until !== undefined && { until }),
  });
  switch (code) {
    case "CHAT_MESSAGE_BLOCKED":
      return failure(blockedText("message"));
    case "CHAT_MUTED":
      return failure("you are timed out for a bit");
    case "CHAT_RATE_LIMITED":
      return failure("slow down a little");
    case "CHAT_DUPLICATE":
      return failure("you just sent that");
    case "CHAT_TEXT_INVALID":
      return failure(`messages need 1 to ${CHAT_LIMITS.text} characters`);
    case "CHAT_MESSAGE_NOT_FOUND":
      return failure("that message is gone");
    case "CHAT_USER_NOT_FOUND":
      return failure("that user has not joined chat yet");
    case "CHAT_FORBIDDEN":
      return failure("you do not have permission for that");
    case "CHAT_CHANNEL_LOCKED":
      return failure("only staff can post here");
    case "CHAT_ROLE_INVALID":
      return failure("that role does not exist");
    case "CHAT_DURATION_INVALID":
      return failure("that length is not allowed");
    case "CHAT_LOGIN_REQUIRED":
      return failure("log in to use chat");
    case "CHAT_PROFILE_BLOCKED":
      return failure(blockedText(field ?? "profile text"));
    case "CHAT_PROFILE_INVALID":
      return failure(`that ${field ?? "profile text"} is too long`);
    case "CHAT_MEDIA_TOO_LARGE":
      return failure("that image is too large");
    case "CHAT_MEDIA_INVALID":
      return failure("that image could not be used");
    case "CHAT_MEDIA_TOO_VARIED":
      return failure("that gif has too many different frames, try a shorter one");
    case "CHAT_MEDIA_BLOCKED":
      return failure(blockedText(isChatMediaKind(body.kind) ? body.kind : "image"));
    case "CHAT_MEDIA_CHECK_UNAVAILABLE":
      return failure("image checks are unavailable right now");
    default:
      return failure("chat action failed");
  }
}

interface ChatRoomOptions {
  channel: ChatChannel;
  visible: boolean;
}

export function useChatRoom({ channel, visible }: ChatRoomOptions) {
  const [access, setAccess] = useState<ChatAccess>({ state: "checking" });
  const [viewer, setViewer] = useState<ChatViewer | null>(null);
  const [history, setHistory] = useState<ChatHistory>(emptyHistory);
  const [exhausted, setExhausted] = useState(emptyFlags);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [typing, setTyping] = useState<Array<ChatTyping & { until: number }>>([]);
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [unread, setUnread] = useState<ChatUnread>({});
  const [blocked, setBlocked] = useState<ChatMember[]>(readBlocked);
  const [attempt, setAttempt] = useState(0);
  const viewRef = useRef({ channel, visible, viewer });
  viewRef.current = { channel, visible, viewer };
  const historyRef = useRef(history);
  historyRef.current = history;
  const syncedRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const foreground = useForegroundTab();

  const post = useCallback(async (path: string, payload: BodyInit, type: string): Promise<ChatResult> => {
    try {
      const response = await fetch(appPath(path), { method: "POST", headers: { "Content-Type": type }, body: payload });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) {
        return {
          ...(body.message !== undefined && { message: body.message as ChatMessage }),
          ...(body.profile !== undefined && { profile: body.profile as ChatProfile }),
          ...(typeof body.removed === "number" && { removed: body.removed }),
        };
      }
      if (response.status === 401 || body.code === "CHAT_BANNED") setAccess(accessFrom(response.status, body));
      return { failure: describeFailure(body.code, body) };
    } catch {
      return { failure: describeFailure(undefined, {}) };
    }
  }, []);

  const request = useCallback(
    (payload: Record<string, unknown>) => post("/api/chat/message", JSON.stringify(payload), "application/json"),
    [post],
  );

  const recheck = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    document.addEventListener("cloudsync-session", recheck);
    return () => document.removeEventListener("cloudsync-session", recheck);
  }, [recheck]);

  useEffect(() => {
    let cancelled = false;
    setAccess((current) => (current.state === "ready" ? current : { state: "checking" }));
    fetch(appPath("/api/chat/me"), { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled) return;
        if (response.ok) setViewer(body.viewer as ChatViewer);
        setAccess(accessFrom(response.status, body));
      })
      .catch(() => {
        if (!cancelled) setAccess({ state: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const ready = access.state === "ready";

  useEffect(() => {
    if (!ready || !foreground) return;
    let events: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    const parse = <T,>(event: MessageEvent<string>) => JSON.parse(event.data) as T;
    const markUnread = (messages: ChatMessage[]) => {
      const view = viewRef.current;
      const self = view.viewer;
      if (!self) return;
      const waiting = messages.filter(
        (message) => message.author !== self.author && !(view.visible && view.channel === message.channel),
      );
      if (!waiting.length) return;
      setUnread((current) => {
        const next = { ...current };
        for (const message of waiting) {
          const previous = next[message.channel];
          const mention = mentionsName(message.text, self.name) || message.reply?.author === self.author;
          next[message.channel] = { count: (previous?.count ?? 0) + 1, mention: !!previous?.mention || mention };
        }
        return next;
      });
    };

    const listeners: Array<[string, (event: MessageEvent<string>) => void]> = [
      [
        "viewer",
        (event) => {
          retryDelay = 1_000;
          setStatus("live");
          setViewer(parse<ChatViewer>(event));
        },
      ],
      [
        "history",
        (event) => {
          const snapshot = parse<Partial<ChatHistory>>(event);
          if (syncedRef.current) {
            const known = historyRef.current;
            markUnread(
              CHAT_CHANNELS.flatMap((key) => {
                const newest = newestId(known[key]);
                return (snapshot[key] ?? []).filter((message) => Number(message.id) > newest);
              }),
            );
          }
          syncedRef.current = true;
          setExhausted(emptyFlags());
          setHistory((current) => {
            const next = emptyHistory();
            for (const key of CHAT_CHANNELS) {
              const confirmed = new Set((snapshot[key] ?? []).map((message) => message.nonce).filter(Boolean));
              const pending = current[key].filter((entry) => entry.pending && !confirmed.has(entry.nonce));
              next[key] = [...(snapshot[key] ?? []), ...pending];
            }
            return next;
          });
        },
      ],
      [
        "message",
        (event) => {
          const message = parse<ChatMessage>(event);
          setHistory((current) => patchChannel(current, message.channel, (entries) => upsert(entries, message)));
          setTyping((current) => current.filter((entry) => entry.author !== message.author));
          markUnread([message]);
        },
      ],
      [
        "update",
        (event) => {
          const message = parse<ChatMessage>(event);
          setHistory((current) =>
            patchChannel(current, message.channel, (entries) =>
              entries.some((entry) => entry.id === message.id) ? upsert(entries, message) : entries,
            ),
          );
        },
      ],
      [
        "remove",
        (event) => {
          const { id, channel: from } = parse<{ id: string; channel: ChatChannel }>(event);
          setHistory((current) => patchChannel(current, from, (entries) => entries.filter((entry) => entry.id !== id)));
        },
      ],
      [
        "typing",
        (event) => {
          const entry = parse<ChatTyping>(event);
          if (entry.author === viewRef.current.viewer?.author) return;
          setTyping((current) => [
            ...current.filter((existing) => existing.author !== entry.author),
            { ...entry, until: Date.now() + TYPING_MS },
          ]);
        },
      ],
      ["members", (event) => setMembers(parse<ChatMember[]>(event))],
      [
        "profile",
        (event) => {
          const card = parse<ChatMember>(event);
          setMembers((current) => current.map((member) => (member.author === card.author ? card : member)));
          setViewer((current) =>
            current?.author === card.author ? withCard(current, card, ["display", "avatar", "status"]) : current,
          );
          setHistory((current) => {
            let next: ChatHistory | undefined;
            for (const key of CHAT_CHANNELS) {
              if (!current[key].some((entry) => entry.author === card.author)) continue;
              next ??= { ...current };
              next[key] = current[key].map((entry) =>
                entry.author === card.author ? withCard(entry, card, ["display", "avatar"]) : entry,
              );
            }
            return next ?? current;
          });
        },
      ],
      [
        "role",
        (event) => {
          const { author, role } = parse<{ author: string; role: ChatRole }>(event);
          setMembers((current) => current.map((member) => (member.author === author ? { ...member, role } : member)));
          setHistory((current) => {
            const next = { ...current };
            for (const key of CHAT_CHANNELS) {
              next[key] = current[key].map((entry) => (entry.author === author ? { ...entry, role } : entry));
            }
            return next;
          });
        },
      ],
      [
        "muted",
        (event) => {
          const { until } = parse<{ until: number }>(event);
          setViewer((current) => {
            if (!current) return current;
            if (until > Date.now()) return { ...current, mutedUntil: until };
            const next = { ...current };
            delete next.mutedUntil;
            return next;
          });
        },
      ],
      ["banned", (event) => setAccess({ state: "banned", ...parse<{ until?: number; reason?: string }>(event) })],
    ];

    const close = () => {
      if (!events) return;
      for (const [name, listener] of listeners) events.removeEventListener(name, listener as EventListener);
      events.onerror = null;
      events.close();
      events = undefined;
    };
    const connect = () => {
      close();
      setStatus("connecting");
      events = new EventSource(appPath("/api/chat/stream"));
      for (const [name, listener] of listeners) events.addEventListener(name, listener as EventListener);
      events.onerror = () => {
        if (events?.readyState !== EventSource.CLOSED) {
          setStatus("connecting");
          return;
        }
        close();
        setStatus("offline");
        retry = setTimeout(() => {
          recheck();
          connect();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };

    connect();
    return () => {
      clearTimeout(retry);
      close();
    };
  }, [foreground, ready, recheck]);

  useEffect(() => {
    if (!typing.length) return;
    const soonest = Math.min(...typing.map((entry) => entry.until));
    const timer = setTimeout(() => {
      const time = Date.now();
      setTyping((current) => current.filter((entry) => entry.until > time));
    }, Math.max(0, soonest - Date.now()));
    return () => clearTimeout(timer);
  }, [typing]);

  useEffect(() => {
    if (!visible || !unread[channel]) return;
    setUnread((current) => {
      const next = { ...current };
      delete next[channel];
      return next;
    });
  }, [channel, unread, visible]);

  const send = useCallback(
    async (target: ChatChannel, text: string, replyTo?: string): Promise<ChatResult> => {
      if (!viewer) return { failure: describeFailure("CHAT_LOGIN_REQUIRED", {}) };
      const nonce = crypto.randomUUID();
      const localId = `local-${nonce}`;
      const pending: ChatEntry = {
        id: localId,
        channel: target,
        author: viewer.author,
        name: viewer.name,
        role: viewer.role,
        ...(viewer.display && { display: viewer.display }),
        ...(viewer.avatar && { avatar: viewer.avatar }),
        text,
        at: Date.now(),
        nonce,
        pending: true,
      };
      setHistory((current) => patchChannel(current, target, (entries) => upsert(entries, pending)));
      const result = await request({ type: "send", channel: target, text, nonce, ...(replyTo && { replyTo }) });
      setHistory((current) =>
        patchChannel(current, target, (entries) =>
          result.message ? upsert(entries, result.message) : entries.filter((entry) => entry.id !== localId),
        ),
      );
      return result;
    },
    [request, viewer],
  );

  const applyUpdate = useCallback((result: ChatResult) => {
    const message = result.message;
    if (message) setHistory((current) => patchChannel(current, message.channel, (entries) => upsert(entries, message)));
    return result;
  }, []);

  const edit = useCallback(
    async (id: string, text: string) => applyUpdate(await request({ type: "edit", id, text })),
    [applyUpdate, request],
  );

  const react = useCallback(
    async (id: string, emoji: string) => applyUpdate(await request({ type: "react", id, emoji })),
    [applyUpdate, request],
  );

  const remove = useCallback((id: string) => request({ type: "delete", id }), [request]);

  const announceTyping = useCallback((target: ChatChannel) => void request({ type: "typing", channel: target }), [request]);

  const moderateUser = useCallback(
    (type: ChatModeration, target: string, extra: Record<string, unknown> = {}) => request({ type, target, ...extra }),
    [request],
  );

  const assignRole = useCallback(
    (name: string, role: ChatRole) => request({ type: "role", targetName: name, role }),
    [request],
  );

  const saveProfile = useCallback(
    (fields: ChatProfileEdit) => post("/api/chat/profile", JSON.stringify(fields), "application/json"),
    [post],
  );

  const uploadMedia = useCallback(
    (kind: ChatMediaKind, image: Blob) => post(`/api/chat/media/${kind}`, image, image.type),
    [post],
  );

  const loadOlder = useCallback(
    async (target: ChatChannel): Promise<number> => {
      const oldest = history[target].find((entry) => !entry.pending);
      if (!oldest || exhausted[target] || loadingOlderRef.current) return 0;
      loadingOlderRef.current = true;
      try {
        const response = await fetch(
          appPath(`/api/chat/history?channel=${encodeURIComponent(target)}&before=${encodeURIComponent(oldest.id)}`),
          { cache: "no-store" },
        );
        if (!response.ok) return 0;
        const { messages } = (await response.json()) as { messages: ChatMessage[] };
        if (messages.length < CHAT_LIMITS.page) setExhausted((current) => ({ ...current, [target]: true }));
        setHistory((current) =>
          patchChannel(current, target, (entries) => {
            const known = new Set(entries.map((entry) => entry.id));
            return [...messages.filter((message) => !known.has(message.id)), ...entries];
          }),
        );
        return messages.length;
      } catch {
        return 0;
      } finally {
        loadingOlderRef.current = false;
      }
    },
    [exhausted, history],
  );

  const loadProfile = useCallback(async (id: string): Promise<ChatProfile | null> => {
    try {
      const response = await fetch(appPath(`/api/chat/profile?id=${encodeURIComponent(id)}`), { cache: "no-store" });
      if (!response.ok) return null;
      return ((await response.json()) as { profile: ChatProfile }).profile;
    } catch {
      return null;
    }
  }, []);

  const toggleBlocked = useCallback((member: ChatMember) => {
    setBlocked((current) => {
      const next = current.some((entry) => entry.author === member.author)
        ? current.filter((entry) => entry.author !== member.author)
        : [...current, { author: member.author, name: member.name, role: member.role }];
      try {
        localStorage.setItem(BLOCKED_STORAGE, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  return {
    access,
    viewer,
    history,
    exhausted,
    members,
    typing,
    status,
    unread,
    blocked,
    recheck,
    send,
    edit,
    react,
    remove,
    announceTyping,
    moderateUser,
    assignRole,
    saveProfile,
    uploadMedia,
    loadOlder,
    loadProfile,
    toggleBlocked,
  };
}
