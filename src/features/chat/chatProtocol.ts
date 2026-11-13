import { roleRank, type ChatRole } from "./chatRoles.ts";

export const CHAT_LIMITS = { text: 500, replySnippet: 120, page: 50 } as const;
export const CHAT_CATEGORIES = [
  { name: "info", channels: ["rules", "announcements", "updates"] },
  { name: "social", channels: ["general", "general-2", "introductions", "art", "debating", "photography", "pets"] },
  { name: "support", channels: ["help", "suggestions", "bugs"] },
  { name: "staff", channels: ["staff-chat"] },
] as const;
export const CHAT_CHANNELS = CHAT_CATEGORIES.flatMap((category) => category.channels);
const CHAT_STAFF_CHANNELS: readonly ChatChannel[] = ["announcements", "rules", "updates"];
export const CHAT_REACTIONS = ["👍", "❤️", "😂", "😮", "😭", "🔥", "💀", "✨"] as const;
export const CHAT_REACTION_FACES = 4;
export const CHAT_PROFILE_LIMITS = { display: 32, pronouns: 24, status: 64, bio: 300, bioLines: 6 } as const;
export const CHAT_MEDIA = {
  avatar: { width: 256, height: 256, bytes: 64 * 1024, gif: { width: 1024, height: 1024, bytes: 2 * 1024 * 1024 } },
  banner: { width: 960, height: 320, bytes: 160 * 1024, gif: { width: 2048, height: 2048, bytes: 4 * 1024 * 1024 } },
} as const;
export const CHAT_MEDIA_TYPES = ["image/webp", "image/jpeg", "image/gif"] as const;
export const CHAT_ATTACHMENT = { width: 1920, height: 1920, bytes: 1024 * 1024, gif: { width: 1280, height: 1280, bytes: 4 * 1024 * 1024 } } as const;
export const CHAT_PROFILE_TEXT = ["display", "pronouns", "status", "bio"] as const;
export const CHAT_CONVERSATION_LIMITS = { name: 32, groupMembers: 10, groups: 30, userSearch: 8 } as const;
export const CHAT_PARTY_LIMITS = { watchers: 50, hosted: 3, query: 2048, idleMs: 10 * 60_000, maxMs: 12 * 60 * 60_000 } as const;
export const CHAT_PARTY_PATHS = { watch: "/stream/watch", anime: "/stream/anime" } as const;
export const CHAT_PARTY_COMMAND = /^\/(?:party|watch)(?=\s|$)/i;

export type ChatChannel = (typeof CHAT_CATEGORIES)[number]["channels"][number];
export type ChatConversationKey = `conv:${number}`;
export type ChatTarget = ChatChannel | ChatConversationKey;
export type ChatConversationKind = "dm" | "group";
export type ChatPartyPath = keyof typeof CHAT_PARTY_PATHS;
export type ChatPartyKind = "movie" | "tv" | "anime";
export type ChatPartyControl = "host" | "everyone";
export type ChatMediaKind = keyof typeof CHAT_MEDIA;
export type ChatProfileText = (typeof CHAT_PROFILE_TEXT)[number];

interface ChatReply {
  id: string;
  author: string;
  name: string;
  text: string;
}

export interface ChatNotice {
  action: "timeout" | "untimeout" | "ban" | "unban" | "create" | "add" | "remove" | "leave" | "rename";
  until?: number;
  by?: string;
  name?: string;
}

export type ChatReactor = Pick<ChatMember, "name" | "display" | "avatar">;

export interface ChatPartyInvite {
  id: string;
  title: string;
  kind: ChatPartyKind;
  poster?: string;
  label?: string;
}

export interface ChatPartyMedia {
  path: ChatPartyPath;
  query: string;
  title: string;
  kind: ChatPartyKind;
  poster?: string;
  label?: string;
}

export interface ChatPartyPlayback {
  paused: boolean;
  position: number;
  at: number;
}

export interface ChatParty extends ChatPartyMedia {
  id: string;
  target: ChatTarget;
  host: string;
  hostName: string;
  control: ChatPartyControl;
  playback: ChatPartyPlayback;
  watchers: ChatMember[];
  startedAt: number;
  ended?: boolean;
}

export interface ChatConversation {
  key: ChatConversationKey;
  kind: ChatConversationKind;
  name?: string;
  owner?: string;
  members: ChatMember[];
  createdAt: number;
  lastAt: number;
  last?: { author: string; name: string; text: string };
  unread: number;
}

export interface ChatMessage {
  id: string;
  channel: ChatTarget;
  author: string;
  name: string;
  role: ChatRole;
  text: string;
  at: number;
  attachment?: { type: string; width: number; height: number };
  display?: string;
  avatar?: string;
  nonce?: string;
  editedAt?: number;
  reply?: ChatReply;
  reactions?: Record<string, string[]>;
  reactors?: Record<string, ChatReactor>;
  notice?: ChatNotice;
  party?: ChatPartyInvite;
}

export interface ChatMember {
  author: string;
  name: string;
  role: ChatRole;
  display?: string;
  avatar?: string;
  status?: string;
}

export interface ChatProfile extends ChatMember {
  joinedAt: number;
  pronouns?: string;
  bio?: string;
  banner?: string;
  mutedUntil?: number;
  bannedUntil?: number;
  banReason?: string;
}

export interface ChatViewer extends ChatMember {
  mutedUntil?: number;
}

export interface ChatTyping {
  author: string;
  name: string;
  channel: ChatTarget;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ZWJ = String.fromCodePoint(0x200d);
const VARIATION = String.fromCodePoint(0xfe0f);

export function isChatChannel(value: unknown): value is ChatChannel {
  return typeof value === "string" && (CHAT_CHANNELS as readonly string[]).includes(value);
}

export function isConversationKey(value: unknown): value is ChatConversationKey {
  return typeof value === "string" && /^conv:[1-9]\d{0,14}$/.test(value);
}

export function isChatTarget(value: unknown): value is ChatTarget {
  return isChatChannel(value) || isConversationKey(value);
}

export function conversationKey(id: number | string): ChatConversationKey {
  return `conv:${id}` as ChatConversationKey;
}

export function conversationIdOf(key: ChatConversationKey): number {
  return Number(key.slice(5));
}

export function isPartyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{12}$/.test(value);
}

export function isPartyControl(value: unknown): value is ChatPartyControl {
  return value === "host" || value === "everyone";
}

export function cleanConversationName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return [...text].length <= CHAT_CONVERSATION_LIMITS.name ? text : null;
}

export function conversationTitle(conversation: Pick<ChatConversation, "kind" | "name" | "members">, viewerAuthor: string): string {
  if (conversation.kind === "group" && conversation.name) return conversation.name;
  const others = conversation.members.filter((member) => member.author !== viewerAuthor);
  if (!others.length) return conversation.kind === "dm" ? "direct message" : "empty group";
  return others.map(displayName).join(", ");
}

const PARTY_DROPPED_KEYS = ["party", "recovery", "resume", "provider"];
const PARTY_POSTER = /^\/!cover!\/[^\s"'<>\\?#]{1,800}$/;

export function readPartyMedia(path: unknown, query: unknown): ChatPartyMedia | null {
  if ((path !== "watch" && path !== "anime") || typeof query !== "string" || query.length > CHAT_PARTY_LIMITS.query) return null;
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  for (const key of PARTY_DROPPED_KEYS) params.delete(key);
  const keys = [...params.keys()];
  if (keys.length > 24 || keys.some((key) => !/^[a-z_][a-zA-Z_]{0,23}$/.test(key))) return null;
  if ([...params.values()].some((value) => value.length > 1024)) return null;
  const title = cleanChatText(params.get("title") ?? "").replace(/\n/g, " ");
  if (!title || title.length > 200) return null;
  const poster = params.get("poster") ?? "";
  if (poster && !PARTY_POSTER.test(poster)) params.delete("poster");
  const episode = /^\d{1,5}$/.test(params.get("episode") ?? "") ? Number(params.get("episode")) : 0;
  const season = /^\d{1,5}$/.test(params.get("season") ?? "") ? Number(params.get("season")) : 0;
  let kind: ChatPartyKind;
  let label: string | undefined;
  if (path === "watch") {
    const type = params.get("media_type");
    if ((type !== "movie" && type !== "tv") || !/^[1-9]\d{0,9}$/.test(params.get("tmdb_id") ?? "")) return null;
    kind = type;
    if (type === "tv") {
      if (!episode) return null;
      label = `S${season || 1}E${episode}`;
    }
  } else {
    if (!episode) return null;
    kind = "anime";
    label = `E${episode}`;
  }
  return {
    path,
    query: params.toString(),
    title,
    kind,
    ...(params.get("poster") && { poster: params.get("poster")! }),
    ...(label && { label }),
  };
}

export function partyPlayerPath(party: Pick<ChatParty, "id" | "path" | "query">): string {
  const params = new URLSearchParams(party.query);
  params.set("party", party.id);
  return `${CHAT_PARTY_PATHS[party.path]}?${params.toString()}`;
}

export function partyPosition(playback: ChatPartyPlayback, serverNow: number): number {
  return playback.paused ? playback.position : playback.position + Math.max(0, serverNow - playback.at) / 1000;
}

export function canPostIn(role: ChatRole, channel: ChatChannel): boolean {
  return canReadChannel(role, channel) && (!CHAT_STAFF_CHANNELS.includes(channel) || roleRank(role) >= roleRank("mod"));
}

export function canReadChannel(role: ChatRole, channel: ChatChannel): boolean {
  return channel !== "staff-chat" || roleRank(role) >= roleRank("mod");
}

export function isChatReaction(value: unknown): value is string {
  return typeof value === "string" && (CHAT_REACTIONS as readonly string[]).includes(value);
}

export function cleanChatText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(INVISIBLE, (char) => (char === ZWJ || char === VARIATION ? char : " ")).replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
  return text.length <= CHAT_LIMITS.text ? text : "";
}

export function isChatMediaKind(value: unknown): value is ChatMediaKind {
  return value === "avatar" || value === "banner";
}

export function isChatAccent(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
}

export function cleanProfileText(field: ChatProfileText, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(INVISIBLE, (char) => (char === ZWJ || char === VARIATION ? char : " ")).replace(/\s+/g, " ").trim());
  const text = field === "bio" ? lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() : lines.join(" ").trim();
  if (field === "bio" && text.split("\n").length > CHAT_PROFILE_LIMITS.bioLines) return null;
  return [...text].length <= CHAT_PROFILE_LIMITS[field] ? text : null;
}

export function displayName(member: Pick<ChatMember, "name" | "display">): string {
  return member.display || member.name;
}

function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [count, unit] =
    minutes % 10_080 === 0 ? [minutes / 10_080, "week"]
      : minutes % 1_440 === 0 ? [minutes / 1_440, "day"]
        : minutes % 60 === 0 ? [minutes / 60, "hour"]
          : [minutes, "minute"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function noticeText(name: string, notice: ChatNotice, at: number): string {
  const length = notice.until ? ` for ${durationLabel(notice.until - at)}` : "";
  if (notice.action === "timeout") return `${name} was timed out${length}`;
  if (notice.action === "untimeout") return `${name} is no longer timed out`;
  if (notice.action === "ban") return `${name} was banned${length}`;
  if (notice.action === "create") return `${name} started the group${notice.name ? ` ${notice.name}` : ""}`;
  if (notice.action === "add") return `${notice.by ?? "someone"} added ${name}`;
  if (notice.action === "remove") return `${notice.by ?? "someone"} removed ${name}`;
  if (notice.action === "leave") return `${name} left the group`;
  if (notice.action === "rename") return notice.name ? `${name} renamed the group to ${notice.name}` : `${name} cleared the group name`;
  return `${name} was unbanned`;
}

export function replySnippet(text: string): string {
  return text.length > CHAT_LIMITS.replySnippet ? `${text.slice(0, CHAT_LIMITS.replySnippet - 1)}…` : text;
}
