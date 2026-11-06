export const CHAT_ROLES = ["owner", "admin", "mod", "member"] as const;

export type ChatRole = (typeof CHAT_ROLES)[number];

const RANK: Record<ChatRole, number> = { owner: 3, admin: 2, mod: 1, member: 0 };

export const CHAT_ROLE_LABELS: Record<ChatRole, string> = {
  owner: "owner",
  admin: "admin",
  mod: "mod",
  member: "member",
};

export const CHAT_TIMEOUTS = [
  { minutes: 5, label: "5 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 7 * 24 * 60, label: "1 week" },
] as const;

export function isChatRole(value: unknown): value is ChatRole {
  return typeof value === "string" && (CHAT_ROLES as readonly string[]).includes(value);
}

export function roleRank(role: ChatRole): number {
  return RANK[role];
}

export function outranks(actor: ChatRole, target: ChatRole): boolean {
  return RANK[actor] > RANK[target];
}

export function canDeleteAny(role: ChatRole): boolean {
  return RANK[role] >= RANK.mod;
}

export function canTimeout(actor: ChatRole, target: ChatRole): boolean {
  return RANK[actor] >= RANK.mod && outranks(actor, target);
}

export function canBan(actor: ChatRole, target: ChatRole): boolean {
  return RANK[actor] >= RANK.admin && outranks(actor, target);
}

export function assignableRoles(actor: ChatRole, target: ChatRole): ChatRole[] {
  if (RANK[actor] < RANK.admin || !outranks(actor, target)) return [];
  return CHAT_ROLES.filter((role) => role !== "owner" && RANK[role] < RANK[actor]);
}
