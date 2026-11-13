import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useManagedModal } from "../../core/ui/modal.ts";
import { negativeMessage, positiveMessage } from "../../core/runtime/messages.ts";
import {
  assignableRoles,
  canBan,
  canTimeout,
  CHAT_ROLE_LABELS,
  CHAT_TIMEOUTS,
  type ChatRole,
} from "../../features/chat/chatRoles.ts";
import {
  CHAT_MEDIA,
  CHAT_PROFILE_LIMITS,
  displayName,
  type ChatMediaKind,
  type ChatMember,
  type ChatProfile as Profile,
  type ChatViewer,
} from "../../features/chat/chatProtocol.ts";
import { avatarColor, chatMediaUrl, encodeChatImage } from "../../features/chat/chatMedia.ts";
import type { ChatModeration, ChatProfileEdit, ChatResult } from "../../features/chat/chatRoom.ts";
import { IconCrossMedium, IconPencil } from "../icons";
import ChatAvatar, { avatarHue } from "./ChatAvatar.tsx";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const FOREVER = 8_000_000_000_000_000;
const TEXT_FIELDS = ["display", "pronouns", "status", "bio"] as const;
const MEDIA_KINDS: ChatMediaKind[] = ["avatar", "banner"];

type TextField = (typeof TEXT_FIELDS)[number];

const TEXT_FIELD_COPY: Record<TextField, { label: string; hint?: string; placeholder: string }> = {
  display: { label: "display name", placeholder: "" },
  pronouns: { label: "pronouns", placeholder: "they/them" },
  status: { label: "status", placeholder: "what are you up to?" },
  bio: { label: "bio", placeholder: "say something about yourself" },
};

function imageErrorText(error: "too_large" | "unreadable", type: string, kind: ChatMediaKind): string {
  if (error === "unreadable") return "that image could not be read";
  if (type !== "image/gif") return "that image is too large";
  const limits = CHAT_MEDIA[kind].gif;
  return `that gif is too large, keep it under ${limits.bytes / 1024 / 1024} mb and ${limits.width}px`;
}

function fitToContent(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}

export function RoleBadge({ role }: { role: ChatRole }) {
  if (role === "member") return null;
  return <span class={`chat-role chat-role-${role}`}>{CHAT_ROLE_LABELS[role]}</span>;
}

interface ChatMemberRowProps {
  member: ChatMember;
  online: boolean;
  self: boolean;
  blocked: boolean;
  tag?: string | undefined;
  onOpen: (member: ChatMember) => void;
}

export function ChatMemberRow({ member, online, self, blocked, tag, onOpen }: ChatMemberRowProps) {
  return (
    <button
      type="button"
      class={`chat-member chat-member-${member.role}${self ? " self" : ""}${blocked ? " blocked" : ""}`}
      onClick={() => onOpen(member)}
    >
      <span class="chat-member-face">
        <ChatAvatar member={member} size={32} />
        {online && <span class="chat-member-dot" />}
      </span>
      <span class="chat-member-text">
        <span class="chat-member-name">{displayName(member)}</span>
        {member.status && <span class="chat-member-status">{member.status}</span>}
      </span>
      {tag && <span class="chat-member-tag">{tag}</span>}
    </button>
  );
}

type TextDraft = Record<TextField, string>;
type MediaDraft = Partial<Record<ChatMediaKind, { blob: Blob; url: string } | null>>;

function draftOf(profile: Profile): TextDraft {
  return {
    display: profile.display ?? "",
    pronouns: profile.pronouns ?? "",
    status: profile.status ?? "",
    bio: profile.bio ?? "",
  };
}

function previewOf(profile: Profile, draft: TextDraft): Profile {
  const next: Profile = { ...profile };
  for (const key of TEXT_FIELDS) {
    const value = draft[key].trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  return next;
}

interface ChatProfileProps {
  author: string;
  fallback: ChatMember;
  viewer: ChatViewer;
  blocked: boolean;
  loadProfile: (id: string) => Promise<Profile | null>;
  moderate: (type: ChatModeration, target: string, extra?: Record<string, unknown>) => Promise<ChatResult>;
  saveProfile: (fields: ChatProfileEdit) => Promise<ChatResult>;
  uploadMedia: (kind: ChatMediaKind, image: Blob) => Promise<ChatResult>;
  onMention: (name: string) => void;
  onMessage: (member: ChatMember) => Promise<ChatResult>;
  onToggleBlock: (member: ChatMember) => void;
  onClose: () => void;
}

export default function ChatProfile({
  author,
  fallback,
  viewer,
  blocked,
  loadProfile,
  moderate,
  saveProfile,
  uploadMedia,
  onMention,
  onMessage,
  onToggleBlock,
  onClose,
}: ChatProfileProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaDraft>({});
  const [sampled, setSampled] = useState<{ src: string; color: string | null } | null>(null);
  const closingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickingRef = useRef<ChatMediaKind>("avatar");
  const mediaRef = useRef(media);
  mediaRef.current = media;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
  }, []);

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: true,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: onClose,
  });

  const refresh = useCallback(() => {
    void loadProfile(author).then((next) => setProfile(next));
  }, [author, loadProfile]);

  useEffect(refresh, [refresh]);

  useEffect(
    () => () => {
      for (const pick of Object.values(mediaRef.current)) if (pick) URL.revokeObjectURL(pick.url);
    },
    [],
  );

  const shown: Profile = profile ?? { ...fallback, joinedAt: 0 };
  const self = viewer.author === author;
  const editing = self && !!draft;
  const timeoutAllowed = !self && canTimeout(viewer.role, shown.role);
  const banAllowed = !self && canBan(viewer.role, shown.role);
  const roles = self ? [] : assignableRoles(viewer.role, shown.role);

  const avatarUrl =
    media.avatar === undefined ? (shown.avatar ? chatMediaUrl("avatar", author, shown.avatar) : null) : (media.avatar?.url ?? null);

  useEffect(() => {
    if (!avatarUrl) return;
    let live = true;
    void avatarColor(avatarUrl).then((color) => {
      if (live) setSampled({ src: avatarUrl, color });
    });
    return () => {
      live = false;
    };
  }, [avatarUrl]);

  const letterColor = `hsl(${avatarHue(author)} 36% 40%)`;
  const bannerColor = !avatarUrl ? letterColor : sampled?.src === avatarUrl ? (sampled.color ?? letterColor) : null;

  const replaceMedia = useCallback((kind: ChatMediaKind, next: { blob: Blob; url: string } | null | undefined) => {
    setMedia((current) => {
      const previous = current[kind];
      if (previous) URL.revokeObjectURL(previous.url);
      const updated = { ...current };
      if (next === undefined) delete updated[kind];
      else updated[kind] = next;
      return updated;
    });
  }, []);

  const editDraft = useCallback((patch: Partial<TextDraft>) => {
    setDraft((current) => current && { ...current, ...patch });
  }, []);

  const stopEditing = useCallback(() => {
    for (const kind of MEDIA_KINDS) replaceMedia(kind, undefined);
    setDraft(null);
  }, [replaceMedia]);

  const commitStatus = useCallback(async () => {
    if (liveStatus === null) return;
    const value = liveStatus.trim();
    if (value === (shown.status ?? "")) {
      setLiveStatus(null);
      return;
    }
    setNotice(null);
    const result = await saveProfile({ status: value || null });
    if (result.failure) {
      setNotice({ text: result.failure.error, tone: "error" });
      return;
    }
    if (result.profile) setProfile(result.profile);
    setLiveStatus(null);
    setNotice({ text: positiveMessage("status saved"), tone: "success" });
  }, [liveStatus, saveProfile, shown.status]);

  const run = useCallback(
    async (type: ChatModeration, extra: Record<string, unknown>, success: string) => {
      setBusy(true);
      setNotice(null);
      const result = await moderate(type, author, extra);
      setBusy(false);
      if (result.failure) {
        setNotice({ text: result.failure.error, tone: "error" });
        return;
      }
      setNotice({ text: positiveMessage(success), tone: "success" });
      refresh();
    },
    [author, moderate, refresh],
  );

  const message = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const result = await onMessage(shown);
    setBusy(false);
    if (result.failure) {
      setNotice({ text: result.failure.error, tone: "error" });
      return;
    }
    requestClose();
  }, [onMessage, requestClose, shown]);

  const pickImage = useCallback(async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const kind = pickingRef.current;
    setBusy(true);
    setNotice(null);
    const result = await encodeChatImage(file, kind);
    setBusy(false);
    if ("error" in result) {
      setNotice({ text: negativeMessage(imageErrorText(result.error, file.type, kind)), tone: "error" });
      return;
    }
    replaceMedia(kind, { blob: result.image, url: URL.createObjectURL(result.image) });
  }, [replaceMedia]);

  const choose = (kind: ChatMediaKind) => {
    pickingRef.current = kind;
    fileRef.current?.click();
  };

  const save = useCallback(async () => {
    if (!draft) return;
    const base = draftOf(shown);
    const fields: ChatProfileEdit = {};
    for (const key of TEXT_FIELDS) {
      const value = draft[key].trim();
      if (value !== base[key]) fields[key] = value || null;
    }
    const steps: Array<() => Promise<ChatResult>> = [];
    for (const kind of MEDIA_KINDS) {
      const pick = media[kind];
      if (pick) steps.push(() => uploadMedia(kind, pick.blob));
      else if (pick === null && shown[kind]) fields[kind] = null;
    }
    if (Object.keys(fields).length) steps.push(() => saveProfile(fields));
    if (!steps.length) {
      stopEditing();
      return;
    }
    setBusy(true);
    setNotice(null);
    let latest: Profile | undefined;
    for (const step of steps) {
      const result = await step();
      if (result.failure) {
        setBusy(false);
        setNotice({ text: result.failure.error, tone: "error" });
        if (latest) setProfile(latest);
        return;
      }
      latest = result.profile ?? latest;
    }
    setBusy(false);
    if (latest) setProfile(latest);
    stopEditing();
    setNotice({ text: positiveMessage("profile saved"), tone: "success" });
  }, [draft, media, saveProfile, shown, stopEditing, uploadMedia]);

  const look = editing ? previewOf(shown, draft) : shown;
  const statusValue = editing ? draft.status : (liveStatus ?? shown.status ?? "");
  const avatarSrc = media.avatar === undefined ? undefined : (media.avatar?.url ?? null);
  const bannerSrc =
    media.banner === undefined ? (look.banner ? chatMediaUrl("banner", author, look.banner) : null) : (media.banner?.url ?? null);
  const hasMedia = (kind: ChatMediaKind) => (media[kind] === undefined ? !!shown[kind] : !!media[kind]);

  const meta: string[] = [];
  if (shown.joinedAt) meta.push(`joined ${dateFormat.format(shown.joinedAt).toLowerCase()}`);
  if (shown.mutedUntil) meta.push(`timed out until ${timeFormat.format(shown.mutedUntil).toLowerCase()}`);
  if (shown.bannedUntil) {
    meta.push(
      shown.bannedUntil >= FOREVER ? "banned forever" : `banned until ${timeFormat.format(shown.bannedUntil).toLowerCase()}`,
    );
  }

  const text = (field: TextField) => {
    if (!editing) return null;
    const copy = TEXT_FIELD_COPY[field];
    return (
      <div class="chat-profile-field">
        <label for={`chat-profile-${field}`}>{copy.label}</label>
        {copy.hint && <p class="chat-profile-hint">{copy.hint}</p>}
        {field === "bio" ? (
          <textarea
            id="chat-profile-bio"
            rows={4}
            value={draft.bio}
            maxLength={CHAT_PROFILE_LIMITS.bio}
            placeholder={copy.placeholder}
            ref={fitToContent}
            onInput={(event) => {
              fitToContent(event.currentTarget);
              editDraft({ bio: event.currentTarget.value });
            }}
          />
        ) : (
          <input
            id={`chat-profile-${field}`}
            type="text"
            value={draft[field]}
            maxLength={CHAT_PROFILE_LIMITS[field]}
            placeholder={field === "display" ? shown.name : copy.placeholder}
            autocomplete="off"
            onInput={(event) => editDraft({ [field]: event.currentTarget.value })}
          />
        )}
      </div>
    );
  };

  const image = (kind: ChatMediaKind, label: string) => (
    <div class="chat-profile-field">
      <label>{label}</label>
      <div class="chat-profile-row">
        <button type="button" class="chat-secondary-btn" disabled={busy} onClick={() => choose(kind)}>
          upload image
        </button>
        <button
          type="button"
          class="chat-secondary-btn"
          disabled={busy || !hasMedia(kind)}
          onClick={() => replaceMedia(kind, null)}
        >
          remove
        </button>
      </div>
    </div>
  );

  return (
    <div
      id="chat-profile-modal"
      class={`popup chat-profile ${modalStateClass}`}
      style={bannerColor ? `--chat-card-accent:${bannerColor}` : undefined}
      onAnimationEnd={onAnimationEnd}
    >
      <div class={`chat-card-banner${bannerSrc ? " has-image" : ""}`}>
        {bannerSrc && <img src={bannerSrc} alt="" decoding="async" draggable={false} />}
        {editing && (
          <button type="button" class="chat-card-change" disabled={busy} onClick={() => choose("banner")}>
            <IconPencil size={16} />
            change banner
          </button>
        )}
      </div>
      <div class="chat-card-head">
        <button
          type="button"
          class="chat-card-avatar"
          disabled={!editing || busy}
          aria-label={editing ? "change avatar" : undefined}
          onClick={() => choose("avatar")}
        >
          <ChatAvatar member={look} size={84} src={avatarSrc} />
          {editing && (
            <span class="chat-card-avatar-edit">
              <IconPencil size={22} />
            </span>
          )}
        </button>
        {self ? (
          <label class="chat-card-status is-editing">
            <span aria-hidden="true">{statusValue || TEXT_FIELD_COPY.status.placeholder}</span>
            <textarea
              rows={1}
              cols={1}
              value={statusValue}
              maxLength={CHAT_PROFILE_LIMITS.status}
              placeholder={TEXT_FIELD_COPY.status.placeholder}
              aria-label={TEXT_FIELD_COPY.status.label}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (!editing) event.currentTarget.blur();
              }}
              onInput={(event) => {
                const next = event.currentTarget.value.replace(/\s*\n\s*/g, " ");
                if (editing) editDraft({ status: next });
                else setLiveStatus(next);
              }}
              onBlur={() => {
                if (!editing) void commitStatus();
              }}
            />
          </label>
        ) : (
          look.status && (
            <p class="chat-card-status" title={look.status}>
              <span>{look.status}</span>
            </p>
          )
        )}
        {self && !editing && (
          <button type="button" class="chat-card-edit" onClick={() => setDraft({ ...draftOf(shown), status: statusValue })}>
            <IconPencil size={14} />
            edit profile
          </button>
        )}
      </div>
      <h2>
        {displayName(look)}
        <RoleBadge role={shown.role} />
      </h2>
      <p class="chat-card-handle">
        <span>@{shown.name}</span>
        {(editing || look.pronouns) && <span aria-hidden="true">·</span>}
        {editing ? (
          <label class="chat-card-pronouns">
            <span aria-hidden="true">{draft.pronouns || TEXT_FIELD_COPY.pronouns.placeholder}</span>
            <input
              type="text"
              size={1}
              value={draft.pronouns}
              maxLength={CHAT_PROFILE_LIMITS.pronouns}
              placeholder={TEXT_FIELD_COPY.pronouns.placeholder}
              aria-label={TEXT_FIELD_COPY.pronouns.label}
              autocomplete="off"
              onInput={(event) => editDraft({ pronouns: event.currentTarget.value })}
            />
          </label>
        ) : (
          look.pronouns && <span>{look.pronouns}</span>
        )}
      </p>
      <div class="input-container">
        {editing ? (
          <>
            {text("display")}
            {text("bio")}
            {image("avatar", "avatar")}
            {image("banner", "banner")}
            <div class="chat-profile-actions">
              <button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? "saving..." : "save"}
              </button>
              <button type="button" class="chat-secondary-btn" disabled={busy} onClick={stopEditing}>
                cancel
              </button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => void pickImage(event)} />
          </>
        ) : (
          <div class="chat-card-panel">
            {look.bio && (
              <div class="chat-profile-field">
                <label>bio</label>
                <p class="chat-card-bio">{look.bio}</p>
              </div>
            )}
            <div class="chat-profile-field">
              <p class="chat-profile-meta">{meta.join(" · ") || "loading..."}</p>
              {shown.banReason && <p class="chat-profile-meta">ban reason: {shown.banReason}</p>}
            </div>
          </div>
        )}

        {!self && (
          <div class="chat-profile-actions">
            <button
              type="button"
              onClick={() => {
                onMention(shown.name);
                requestClose();
              }}
            >
              mention
            </button>
            <button type="button" class="chat-secondary-btn" disabled={busy} onClick={() => void message()}>
              message
            </button>
            <button type="button" class="chat-secondary-btn" onClick={() => onToggleBlock(shown)}>
              {blocked ? "unblock" : "block"}
            </button>
          </div>
        )}

        {roles.length > 0 && (
          <div class="chat-profile-field">
            <label>role</label>
            <p class="chat-profile-hint">mods can time out, ban, and reset profiles. admins can also set roles.</p>
            <div class="chat-profile-row">
              {roles.map((role) => (
                <button
                  type="button"
                  key={role}
                  class={role === shown.role ? "" : "chat-secondary-btn"}
                  disabled={busy || role === shown.role}
                  onClick={() => void run("role", { role }, `${shown.name} is now ${CHAT_ROLE_LABELS[role]}`)}
                >
                  {CHAT_ROLE_LABELS[role]}
                </button>
              ))}
            </div>
          </div>
        )}

        {timeoutAllowed && (
          <div class="chat-profile-field">
            <label>timeout</label>
            <p class="chat-profile-hint">they can still read chat but cannot send messages.</p>
            <div class="chat-profile-row">
              {CHAT_TIMEOUTS.map((option) => (
                <button
                  type="button"
                  key={option.minutes}
                  class="chat-secondary-btn"
                  disabled={busy}
                  onClick={() => void run("timeout", { minutes: option.minutes }, `${shown.name} is timed out for ${option.label}`)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {shown.mutedUntil && (
              <div class="chat-profile-row">
                <button type="button" disabled={busy} onClick={() => void run("untimeout", {}, "timeout ended")}>
                  end timeout
                </button>
              </div>
            )}
          </div>
        )}

        {timeoutAllowed && (
          <div class="chat-profile-field">
            <label>reset profile</label>
            <p class="chat-profile-hint">clears everything they set, including images.</p>
            <div class="chat-profile-row">
              <button
                type="button"
                class="chat-secondary-btn"
                disabled={busy}
                onClick={() => void run("clearprofile", {}, `${shown.name}'s profile is reset`)}
              >
                reset profile
              </button>
            </div>
          </div>
        )}

        {banAllowed && (
          <div class="chat-profile-field">
            <label for="chat-ban-reason">ban</label>
            {shown.bannedUntil ? (
              <>
                <p class="chat-profile-hint">they cannot use chat until they are unbanned.</p>
                <div class="chat-profile-row">
                  <button type="button" disabled={busy} onClick={() => void run("unban", {}, `${shown.name} is unbanned`)}>
                    unban
                  </button>
                </div>
              </>
            ) : (
              <>
                <p class="chat-profile-hint">removes them from chat. they will see the reason if you give one.</p>
                <input
                  id="chat-ban-reason"
                  type="text"
                  value={reason}
                  maxLength={200}
                  placeholder="reason (optional)"
                  autocomplete="off"
                  onInput={(event) => setReason(event.currentTarget.value)}
                />
                <div class="chat-profile-row">
                  <button
                    type="button"
                    class="chat-danger-btn"
                    disabled={busy}
                    onClick={() => void run("ban", { reason }, `${shown.name} is banned`)}
                  >
                    ban
                  </button>
                  <button
                    type="button"
                    class="chat-danger-btn"
                    disabled={busy}
                    onClick={() => void run("ban", { reason, purge: true }, `${shown.name} is banned and their last 24h of messages are deleted`)}
                  >
                    ban + delete last 24h
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {notice && (
          <p class="chat-profile-notice" data-tone={notice.tone} aria-live="polite">
            {notice.text}
          </p>
        )}
      </div>
      <button type="button" class="modal-close-btn" aria-label="close" onClick={requestClose}>
        <IconCrossMedium />
      </button>
    </div>
  );
}
