import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { blockedNotice, isModerationCategory, type ModerationCategory } from "./moderationNotice.ts";
import type { ChatRole } from "./chatRoles.ts";
import { mentionsName } from "./chatText.ts";
import {
  CHAT_CHANNELS,
  CHAT_CONVERSATION_LIMITS,
  CHAT_LIMITS,
  CHAT_PARTY_LIMITS,
  type ChatChannel,
  type ChatConversation,
  type ChatConversationKey,
  type ChatMediaKind,
  type ChatMember,
  type ChatMessage,
  type ChatParty,
  type ChatPartyPath,
  type ChatProfile,
  type ChatTarget,
  type ChatTyping,
  type ChatViewer,
  displayName,
  isChatMediaKind,
  isConversationKey,
  canReadChannel,
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
export type ChatHistory = Record<ChatChannel, ChatEntry[]> & Partial<Record<ChatConversationKey, ChatEntry[]>>;
export type ChatUnread = Partial<Record<ChatTarget, { count: number; mention: boolean }>>;
export type ChatParties = Readonly<Record<string, ChatParty>>;

export interface ChatFailure {
  error: string;
  code?: string;
  until?: number;
}

export type ChatResult = {
  message?: ChatMessage;
  profile?: ChatProfile;
  conversation?: ChatConversation;
  party?: ChatParty;
  failure?: ChatFailure;
  removed?: number;
};
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
const READ_DELAY_MS = 600;
const NO_ENTRIES: ChatEntry[] = [];

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

function readable(role: ChatRole, target: ChatTarget): boolean {
  return isConversationKey(target) || canReadChannel(role, target);
}

function byLatest(conversations: ChatConversation[]): ChatConversation[] {
  return conversations.slice().sort((left, right) => right.lastAt - left.lastAt);
}

function withoutKey<T extends object>(record: T, key: PropertyKey): T {
  if (!Object.hasOwn(record, key)) return record;
  const next = { ...record };
  delete next[key as keyof T];
  return next;
}

function mergeNewest(entries: ChatEntry[], messages: ChatMessage[]): ChatEntry[] {
  const newest = newestId(messages);
  const known = new Set(messages.map((message) => message.id));
  const confirmed = new Set(messages.map((message) => message.nonce).filter(Boolean));
  const later = entries.filter((entry) =>
    entry.pending ? !confirmed.has(entry.nonce) : !known.has(entry.id) && Number(entry.id) > newest,
  );
  return [...messages, ...later].slice(-VISIBLE_LIMIT);
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

function patchTarget(history: ChatHistory, target: ChatTarget, update: (entries: ChatEntry[]) => ChatEntry[]): ChatHistory {
  const current = history[target] ?? NO_ENTRIES;
  const next = update(current);
  return next === current ? history : { ...history, [target]: next };
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
    ...(typeof code === "string" && { code }),
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
    case "CHAT_NAME_BLOCKED":
      return failure(blockedText("group name"));
    case "CHAT_NAME_INVALID":
      return failure(`group names can be up to ${CHAT_CONVERSATION_LIMITS.name} characters`);
    case "CHAT_GROUP_LIMIT":
      return failure("you are in too many groups");
    case "CHAT_GROUP_FULL":
      return failure(`groups can have up to ${CHAT_CONVERSATION_LIMITS.groupMembers} people`);
    case "CHAT_CONVERSATION_NOT_FOUND":
      return failure("that conversation is gone");
    case "CHAT_PARTY_INVALID":
      return failure("that title cannot be watched together");
    case "CHAT_PARTY_LIMIT":
      return failure(`you already have ${CHAT_PARTY_LIMITS.hosted} watch parties running`);
    case "CHAT_PARTY_NOT_FOUND":
      return failure("that watch party has ended");
    case "CHAT_PARTY_FULL":
      return failure("that watch party is full");
    default:
      return failure("chat action failed");
  }
}

interface ChatRoomOptions {
  target: ChatTarget;
  visible: boolean;
}

export function useChatRoom({ target, visible }: ChatRoomOptions) {
  const [access, setAccess] = useState<ChatAccess>({ state: "checking" });
  const [viewer, setViewer] = useState<ChatViewer | null>(null);
  const [history, setHistory] = useState<ChatHistory>(emptyHistory);
  const [exhausted, setExhausted] = useState<Partial<Record<ChatTarget, boolean>>>({});
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [parties, setParties] = useState<ChatParties>({});
  const [typing, setTyping] = useState<Array<ChatTyping & { until: number }>>([]);
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [unread, setUnread] = useState<ChatUnread>({});
  const [blocked, setBlocked] = useState<ChatMember[]>(readBlocked);
  const [attempt, setAttempt] = useState(0);
  const [syncCount, setSyncCount] = useState(0);
  const viewRef = useRef({ target, visible, viewer });
  viewRef.current = { target, visible, viewer };
  const historyRef = useRef(history);
  historyRef.current = history;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const syncedRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const freshRef = useRef(new Set<ChatConversationKey>());
  const readRef = useRef(new Map<ChatConversationKey, number>());
  const foreground = useForegroundTab();
  const updateViewer = useCallback((next: ChatViewer) => {
    viewRef.current.viewer = next;
    setViewer(next);
    setHistory((current) => {
      const hidden = CHAT_CHANNELS.filter((key) => !canReadChannel(next.role, key) && current[key].length);
      return hidden.length ? { ...current, ...Object.fromEntries(hidden.map((key) => [key, []])) } : current;
    });
    setUnread((current) => Object.fromEntries(Object.entries(current).filter(([key]) => readable(next.role, key as ChatTarget))));
    setTyping((current) => current.filter((entry) => readable(next.role, entry.channel)));
    setParties((current) => Object.fromEntries(Object.entries(current).filter(([, party]) => readable(next.role, party.target))));
  }, []);

  const call = useCallback(async (path: string, init: RequestInit): Promise<ChatResult> => {
    try {
      const response = await fetch(appPath(path), init);
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) {
        return {
          ...(body.message !== undefined && { message: body.message as ChatMessage }),
          ...(body.profile !== undefined && { profile: body.profile as ChatProfile }),
          ...(body.conversation !== undefined && { conversation: body.conversation as ChatConversation }),
          ...(body.party !== undefined && { party: body.party as ChatParty }),
          ...(typeof body.removed === "number" && { removed: body.removed }),
        };
      }
      if (response.status === 401 || body.code === "CHAT_BANNED") setAccess(accessFrom(response.status, body));
      return { failure: describeFailure(body.code, body) };
    } catch {
      return { failure: describeFailure(undefined, {}) };
    }
  }, []);

  const post = useCallback(
    (path: string, payload: BodyInit, type?: string) =>
      call(path, { method: "POST", headers: type ? { "Content-Type": type } : {}, body: payload }),
    [call],
  );

  const request = useCallback(
    (payload: Record<string, unknown>) => post("/api/chat/message", JSON.stringify(payload), "application/json"),
    [post],
  );

  const touchConversation = useCallback((message: ChatMessage) => {
    if (!isConversationKey(message.channel)) return;
    setConversations((current) => {
      const index = current.findIndex((conversation) => conversation.key === message.channel);
      const conversation = current[index];
      if (!conversation || message.at < conversation.lastAt) return current;
      const touched: ChatConversation = {
        ...conversation,
        lastAt: message.at,
        last: { author: message.author, name: displayName(message), text: message.text },
      };
      return byLatest([...current.slice(0, index), touched, ...current.slice(index + 1)]);
    });
  }, []);

  const storeConversation = useCallback((conversation: ChatConversation) => {
    setConversations((current) => byLatest([conversation, ...current.filter((entry) => entry.key !== conversation.key)]));
  }, []);

  const dropConversation = useCallback((key: ChatConversationKey) => {
    freshRef.current.delete(key);
    readRef.current.delete(key);
    setConversations((current) => current.filter((conversation) => conversation.key !== key));
    setHistory((current) => withoutKey(current, key));
    setExhausted((current) => withoutKey(current, key));
    setUnread((current) => withoutKey(current, key));
    setTyping((current) => current.filter((entry) => entry.channel !== key));
  }, []);

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
        if (response.ok) updateViewer(body.viewer as ChatViewer);
        setAccess(accessFrom(response.status, body));
      })
      .catch(() => {
        if (!cancelled) setAccess({ state: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, updateViewer]);

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
        (message) => readable(self.role, message.channel) && message.author !== self.author && !(view.visible && view.target === message.channel),
      );
      if (!waiting.length) return;
      const direct = new Set(conversationsRef.current.filter((conversation) => conversation.kind === "dm").map((conversation) => conversation.key));
      setUnread((current) => {
        const next = { ...current };
        for (const message of waiting) {
          const previous = next[message.channel];
          const mention =
            (isConversationKey(message.channel) && direct.has(message.channel)) ||
            mentionsName(message.text, self.name) ||
            message.reply?.author === self.author;
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
          updateViewer(parse<ChatViewer>(event));
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
          setExhausted({});
          setHistory((current) => {
            const next = emptyHistory();
            for (const key of Object.keys(current) as ChatTarget[]) {
              if (isConversationKey(key)) next[key] = current[key];
            }
            for (const key of CHAT_CHANNELS) {
              if (!canReadChannel(viewRef.current.viewer?.role ?? "member", key)) continue;
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
          if (!readable(viewRef.current.viewer?.role ?? "member", message.channel)) return;
          setHistory((current) => patchTarget(current, message.channel, (entries) => upsert(entries, message)));
          setTyping((current) => current.filter((entry) => entry.author !== message.author));
          touchConversation(message);
          markUnread([message]);
        },
      ],
      [
        "update",
        (event) => {
          const message = parse<ChatMessage>(event);
          if (!readable(viewRef.current.viewer?.role ?? "member", message.channel)) return;
          setHistory((current) =>
            patchTarget(current, message.channel, (entries) =>
              entries.some((entry) => entry.id === message.id) ? upsert(entries, message) : entries,
            ),
          );
        },
      ],
      [
        "remove",
        (event) => {
          const { id, channel: from } = parse<{ id: string; channel: ChatTarget }>(event);
          setHistory((current) => patchTarget(current, from, (entries) => entries.filter((entry) => entry.id !== id)));
        },
      ],
      [
        "typing",
        (event) => {
          const entry = parse<ChatTyping>(event);
          if (!readable(viewRef.current.viewer?.role ?? "member", entry.channel)) return;
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
            for (const key of Object.keys(current) as ChatTarget[]) {
              const entries = current[key] ?? NO_ENTRIES;
              if (!entries.some((entry) => entry.author === card.author || entry.reactors?.[card.author])) continue;
              next ??= { ...current };
              next[key] = entries.map((entry) => {
                const shown = entry.author === card.author ? withCard(entry, card, ["display", "avatar"]) : entry;
                const reactor = shown.reactors?.[card.author];
                if (!reactor) return shown;
                const face = { name: reactor.name, ...(card.display && { display: card.display }), ...(card.avatar && { avatar: card.avatar }) };
                return { ...shown, reactors: { ...shown.reactors, [card.author]: face } };
              });
            }
            return next ?? current;
          });
          setConversations((current) =>
            current.some((conversation) => conversation.members.some((member) => member.author === card.author))
              ? current.map((conversation) => ({
                  ...conversation,
                  members: conversation.members.map((member) => (member.author === card.author ? card : member)),
                }))
              : current,
          );
        },
      ],
      [
        "role",
        (event) => {
          const { author, role } = parse<{ author: string; role: ChatRole }>(event);
          setMembers((current) => current.map((member) => (member.author === author ? { ...member, role } : member)));
          setHistory((current) => {
            const next = { ...current };
            for (const key of Object.keys(current) as ChatTarget[]) {
              next[key] = (current[key] ?? NO_ENTRIES).map((entry) => (entry.author === author ? { ...entry, role } : entry));
            }
            return next;
          });
          setConversations((current) =>
            current.map((conversation) => ({
              ...conversation,
              members: conversation.members.map((member) => (member.author === author ? { ...member, role } : member)),
            })),
          );
        },
      ],
      [
        "conversations",
        (event) => {
          const list = byLatest(parse<ChatConversation[]>(event));
          const view = viewRef.current;
          const keys = new Set(list.map((conversation) => conversation.key));
          const direct = new Set(list.filter((conversation) => conversation.kind === "dm").map((conversation) => conversation.key));
          freshRef.current = new Set();
          readRef.current = new Map();
          conversationsRef.current = list;
          setConversations(list);
          setHistory((current) => {
            let next: ChatHistory | undefined;
            for (const key of Object.keys(current) as ChatTarget[]) {
              if (!isConversationKey(key) || (key === view.target && keys.has(key))) continue;
              const pending = (current[key] ?? NO_ENTRIES).filter((entry) => entry.pending);
              next ??= { ...current };
              if (pending.length && keys.has(key)) next[key] = pending;
              else delete next[key];
            }
            return next ?? current;
          });
          setUnread((current) => {
            const next: ChatUnread = Object.fromEntries(Object.entries(current).filter(([key]) => !isConversationKey(key)));
            for (const conversation of list) {
              if (conversation.unread <= 0 || (view.visible && view.target === conversation.key)) continue;
              next[conversation.key] = {
                count: conversation.unread,
                mention: direct.has(conversation.key) || !!current[conversation.key]?.mention,
              };
            }
            return next;
          });
          setTyping((current) => current.filter((entry) => !isConversationKey(entry.channel) || keys.has(entry.channel)));
          setSyncCount((value) => value + 1);
        },
      ],
      [
        "conversation",
        (event) => {
          const conversation = parse<ChatConversation>(event);
          const view = viewRef.current;
          const active = view.visible && view.target === conversation.key;
          storeConversation(conversation);
          setUnread((current) => {
            if (active || conversation.unread <= 0) return withoutKey(current, conversation.key);
            const mention = conversation.kind === "dm" || !!current[conversation.key]?.mention;
            return { ...current, [conversation.key]: { count: conversation.unread, mention } };
          });
        },
      ],
      [
        "conversation-remove",
        (event) => {
          const { key } = parse<{ key: ChatConversationKey }>(event);
          if (isConversationKey(key)) dropConversation(key);
        },
      ],
      [
        "read",
        (event) => {
          const { channel: key, id } = parse<{ channel: ChatTarget; id: string }>(event);
          if (!isConversationKey(key)) return;
          const self = viewRef.current.viewer?.author;
          const remaining = (historyRef.current[key] ?? NO_ENTRIES).filter(
            (entry) => !entry.pending && Number(entry.id) > Number(id) && entry.author !== self,
          ).length;
          readRef.current.set(key, Math.max(readRef.current.get(key) ?? 0, Number(id) || 0));
          setUnread((current) => {
            const previous = current[key];
            if (!previous) return current;
            return remaining ? { ...current, [key]: { ...previous, count: remaining } } : withoutKey(current, key);
          });
        },
      ],
      [
        "parties",
        (event) => {
          const list = parse<ChatParty[]>(event);
          setParties(Object.fromEntries(list.filter((party) => !party.ended).map((party) => [party.id, party])));
        },
      ],
      [
        "party",
        (event) => {
          const party = parse<ChatParty>(event);
          setParties((current) => (party.ended ? withoutKey(current, party.id) : { ...current, [party.id]: party }));
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
  }, [dropConversation, foreground, ready, recheck, storeConversation, touchConversation, updateViewer]);

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
    if (!visible || !unread[target]) return;
    setUnread((current) => withoutKey(current, target));
  }, [target, unread, visible]);

  useEffect(() => {
    if (!ready || !isConversationKey(target) || freshRef.current.has(target)) return;
    const key = target;
    freshRef.current.add(key);
    void (async () => {
      try {
        const response = await fetch(appPath(`/api/chat/history?channel=${encodeURIComponent(key)}`), { cache: "no-store" });
        if (!response.ok) {
          freshRef.current.delete(key);
          return;
        }
        const { messages } = (await response.json()) as { messages: ChatMessage[] };
        if (!conversationsRef.current.some((conversation) => conversation.key === key)) return;
        setExhausted((current) => ({ ...current, [key]: messages.length < CHAT_LIMITS.page }));
        setHistory((current) => patchTarget(current, key, (entries) => mergeNewest(entries, messages)));
      } catch {
        freshRef.current.delete(key);
      }
    })();
  }, [ready, syncCount, target]);

  const newestShown = isConversationKey(target) ? newestId(history[target] ?? NO_ENTRIES) : 0;

  useEffect(() => {
    if (!ready || !visible || !isConversationKey(target) || !newestShown) return;
    if ((readRef.current.get(target) ?? 0) >= newestShown) return;
    const key = target;
    const timer = setTimeout(() => {
      readRef.current.set(key, newestShown);
      void request({ type: "read", channel: key, id: String(newestShown) });
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [newestShown, ready, request, syncCount, target, visible]);

  const send = useCallback(
    async (target: ChatTarget, text: string, replyTo?: string, image?: Blob): Promise<ChatResult> => {
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
      if (!image) setHistory((current) => patchTarget(current, target, (entries) => upsert(entries, pending)));
      let result: ChatResult;
      if (image) {
        const form = new FormData();
        form.set("channel", target);
        form.set("text", text);
        form.set("nonce", nonce);
        if (replyTo) form.set("replyTo", replyTo);
        form.set("image", image, "upload");
        result = await post("/api/chat/message", form);
      } else {
        result = await request({ type: "send", channel: target, text, nonce, ...(replyTo && { replyTo }) });
      }
      setHistory((current) =>
        patchTarget(current, target, (entries) =>
          !readable(viewRef.current.viewer?.role ?? "member", target) ? []
            : result.message ? upsert(entries, result.message) : entries.filter((entry) => entry.id !== localId),
        ),
      );
      if (result.message) touchConversation(result.message);
      return result;
    },
    [post, request, touchConversation, viewer],
  );

  const applyUpdate = useCallback((result: ChatResult) => {
    const message = result.message;
    if (message && readable(viewRef.current.viewer?.role ?? "member", message.channel)) {
      setHistory((current) => patchTarget(current, message.channel, (entries) => upsert(entries, message)));
    }
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

  const announceTyping = useCallback((target: ChatTarget) => void request({ type: "typing", channel: target }), [request]);

  const checkDraft = useCallback(async (text: string): Promise<ModerationCategory | null | undefined> => {
    try {
      const response = await fetch(appPath("/api/chat/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "draft", text }),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Record<string, unknown>;
      return isModerationCategory(body.category) ? body.category : null;
    } catch {
      return undefined;
    }
  }, []);

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
    async (target: ChatTarget): Promise<number> => {
      const oldest = (history[target] ?? NO_ENTRIES).find((entry) => !entry.pending);
      if (!oldest || exhausted[target] || loadingOlderRef.current) return 0;
      loadingOlderRef.current = true;
      try {
        const response = await fetch(
          appPath(`/api/chat/history?channel=${encodeURIComponent(target)}&before=${encodeURIComponent(oldest.id)}`),
          { cache: "no-store" },
        );
        if (!response.ok) return 0;
        const { messages } = (await response.json()) as { messages: ChatMessage[] };
        if (!readable(viewRef.current.viewer?.role ?? "member", target)) return 0;
        if (messages.length < CHAT_LIMITS.page) setExhausted((current) => ({ ...current, [target]: true }));
        setHistory((current) =>
          patchTarget(current, target, (entries) => {
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

  const applyConversation = useCallback(
    (result: ChatResult) => {
      if (result.conversation) storeConversation(result.conversation);
      return result;
    },
    [storeConversation],
  );

  const openDm = useCallback(
    async (author: string) => applyConversation(await request({ type: "dm", target: author })),
    [applyConversation, request],
  );

  const createGroup = useCallback(
    async (name: string, people: string[]) =>
      applyConversation(await request({ type: "group", ...(name && { name }), members: people })),
    [applyConversation, request],
  );

  const addMembers = useCallback(
    async (key: ChatConversationKey, people: string[]) =>
      applyConversation(await request({ type: "group-add", channel: key, members: people })),
    [applyConversation, request],
  );

  const removeMember = useCallback(
    async (key: ChatConversationKey, author: string) =>
      applyConversation(await request({ type: "group-remove", channel: key, target: author })),
    [applyConversation, request],
  );

  const renameGroup = useCallback(
    async (key: ChatConversationKey, name: string) =>
      applyConversation(await request({ type: "group-rename", channel: key, name })),
    [applyConversation, request],
  );

  const leaveConversation = useCallback(
    async (key: ChatConversationKey) => {
      const result = await request({ type: "leave", channel: key });
      if (!result.failure) dropConversation(key);
      return result;
    },
    [dropConversation, request],
  );

  const searchUsers = useCallback(async (query: string, signal?: AbortSignal): Promise<ChatMember[]> => {
    try {
      const response = await fetch(appPath(`/api/chat/users?q=${encodeURIComponent(query)}`), { cache: "no-store", ...(signal && { signal }) });
      if (!response.ok) return [];
      const { users } = (await response.json()) as { users?: ChatMember[] };
      return Array.isArray(users) ? users : [];
    } catch {
      return [];
    }
  }, []);

  const storeParty = useCallback((result: ChatResult, id: string) => {
    const party = result.party;
    if (party && !party.ended) setParties((current) => ({ ...current, [party.id]: party }));
    else if (party?.ended || result.failure?.code === "CHAT_PARTY_NOT_FOUND") setParties((current) => withoutKey(current, id));
    return result;
  }, []);

  const createParty = useCallback(
    async (target: ChatTarget, path: ChatPartyPath, query: string) => {
      const result = applyUpdate(await request({ type: "party", channel: target, path, query }));
      if (result.message) touchConversation(result.message);
      return result.party ? storeParty(result, result.party.id) : result;
    },
    [applyUpdate, request, storeParty, touchConversation],
  );

  const loadParty = useCallback(
    async (id: string) => storeParty(await call(`/api/chat/party?id=${encodeURIComponent(id)}`, { cache: "no-store" }), id),
    [call, storeParty],
  );

  const endParty = useCallback(
    async (id: string) => {
      const result = await request({ type: "party-end", id });
      if (!result.failure || result.failure.code === "CHAT_PARTY_NOT_FOUND") setParties((current) => withoutKey(current, id));
      return result;
    },
    [request],
  );

  return {
    access,
    viewer,
    history,
    exhausted,
    members,
    conversations,
    parties,
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
    checkDraft,
    moderateUser,
    assignRole,
    saveProfile,
    uploadMedia,
    loadOlder,
    loadProfile,
    toggleBlocked,
    openDm,
    createGroup,
    addMembers,
    removeMember,
    renameGroup,
    leaveConversation,
    searchUsers,
    createParty,
    loadParty,
    endParty,
  };
}
