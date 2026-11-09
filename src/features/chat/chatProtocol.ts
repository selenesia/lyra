import { roleRank, type ChatRole } from "./chatRoles.ts";

export const CHAT_LIMITS = { text: 500, replySnippet: 120, page: 50 } as const;
export const CHAT_CATEGORIES = [
  { name: "info", channels: ["rules", "announcements", "updates"] },
  { name: "social", channels: ["general", "introductions", "off-topic"] },
  { name: "interests", channels: ["games", "anime", "manga", "music", "movies", "tech"] },
  { name: "support", channels: ["help", "suggestions", "bugs"] },
] as const;
export const CHAT_CHANNELS = CHAT_CATEGORIES.flatMap((category) => category.channels);
const CHAT_STAFF_CHANNELS: readonly ChatChannel[] = ["announcements", "rules", "updates"];
export const CHAT_REACTIONS = ["👍", "❤️", "😂", "😮", "😭", "🔥", "💀", "✨"] as const;
export const CHAT_PROFILE_LIMITS = { display: 32, pronouns: 24, status: 64, bio: 300, bioLines: 6 } as const;
export const CHAT_MEDIA = {
  avatar: { width: 256, height: 256, bytes: 64 * 1024, gif: { width: 1024, height: 1024, bytes: 2 * 1024 * 1024 } },
  banner: { width: 960, height: 320, bytes: 160 * 1024, gif: { width: 2048, height: 2048, bytes: 4 * 1024 * 1024 } },
} as const;
export const CHAT_MEDIA_TYPES = ["image/webp", "image/jpeg", "image/gif"] as const;
export const CHAT_PROFILE_TEXT = ["display", "pronouns", "status", "bio"] as const;

export type ChatChannel = (typeof CHAT_CATEGORIES)[number]["channels"][number];
export type ChatMediaKind = keyof typeof CHAT_MEDIA;
export type ChatProfileText = (typeof CHAT_PROFILE_TEXT)[number];

interface ChatReply {
  id: string;
  author: string;
  name: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  author: string;
  name: string;
  role: ChatRole;
  text: string;
  at: number;
  display?: string;
  avatar?: string;
  nonce?: string;
  editedAt?: number;
  reply?: ChatReply;
  reactions?: Record<string, string[]>;
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
  channel: ChatChannel;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ZWJ = String.fromCodePoint(0x200d);
const VARIATION = String.fromCodePoint(0xfe0f);

export function isChatChannel(value: unknown): value is ChatChannel {
  return typeof value === "string" && (CHAT_CHANNELS as readonly string[]).includes(value);
}

export function canPostIn(role: ChatRole, channel: ChatChannel): boolean {
  return !CHAT_STAFF_CHANNELS.includes(channel) || roleRank(role) >= roleRank("mod");
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

export function replySnippet(text: string): string {
  return text.length > CHAT_LIMITS.replySnippet ? `${text.slice(0, CHAT_LIMITS.replySnippet - 1)}…` : text;
}
