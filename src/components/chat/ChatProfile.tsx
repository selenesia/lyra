import {
  CHAT_NAME_EFFECTS,
  CHAT_NAME_FONTS,
  CHAT_NAME_PALETTES,
  CHAT_NAME_SOLIDS,
  CHAT_NAME_STYLE_FIELDS,
  chatNameSwatch,
  isCustomNameColor,
  prefersDarkText,
  type ChatNameStyleDraft,
  type ChatNameStyleField,
} from "../../features/chat/chatNameStyle.ts";
import ChatDisplayName from "./ChatDisplayName.tsx";
import ChatColorPicker from "./ChatColorPicker.tsx";
import { memo } from "preact/compat";
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
  CHAT_COSMETIC_SLOTS,
  CHAT_MEDIA,
  CHAT_PROFILE_COLORS,
  CHAT_PROFILE_LIMITS,
  CHAT_VOICE_NAMES,
  type ChatCosmeticSlot,
  type ChatMediaKind,
  type ChatMember,
  type ChatProfile as Profile,
  type ChatProfileColor,
  type ChatViewer,
  type ChatVoiceChannel,
} from "../../features/chat/chatProtocol.ts";
import { avatarColor, chatMediaUrl, encodeChatImage, sampledAvatarColor } from "../../features/chat/chatMedia.ts";
import { cachedProfile, profileIntent } from "../../features/chat/chatProfiles.ts";
import { useCosmetics } from "../../features/chat/chatCosmetics.ts";
import type { ChatModeration, ChatProfileEdit, ChatResult } from "../../features/chat/chatRoom.ts";
import { IconCrossMedium, IconPencil } from "../icons";
import type { TutorialProfileStage } from "../layout/Tutorial.tsx";
import ChatAvatar, { avatarHue } from "./ChatAvatar.tsx";
import { CosmeticPicker, MemberNameplate, ProfileEffect, ProfileFrame } from "./ChatCosmetics.tsx";
import { SeasonTabs } from "../watch/SeasonTabs.tsx";
import { useChatDialogNotice } from "./useChatDialogNotice.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const FOREVER = 8_000_000_000_000_000;
const TEXT_FIELDS = ["display", "pronouns", "status", "bio"] as const;
const MEDIA_KINDS: ChatMediaKind[] = ["avatar", "banner"];
const SPLIT_EDITOR_QUERY = "(min-width: 760px)";

function useSplitEditor(): boolean {
  const [split, setSplit] = useState(() => window.matchMedia(SPLIT_EDITOR_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(SPLIT_EDITOR_QUERY);
    const update = () => setSplit(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return split;
}

type TextField = (typeof TEXT_FIELDS)[number];

const TEXT_FIELD_COPY: Record<TextField, { label: string; hint?: string; placeholder: string }> = {
  display: { label: "display name", placeholder: "" },
  pronouns: { label: "pronouns", placeholder: "they/them" },
  status: { label: "status", placeholder: "hello!" },
  bio: { label: "bio", placeholder: "say something about yourself" },
};

const PROFILE_COLOR_LABELS: Record<ChatProfileColor, string> = {
  accent: "primary color",
  accentSecondary: "secondary color",
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
  onOpen: (member: ChatMember) => void;
}

export const ChatMemberRow = memo(function ChatMemberRow({ member, online, self, blocked, onOpen }: ChatMemberRowProps) {
  const [hovered, setHovered] = useState(false);
  const decorated = !!(member.decoration || member.nameplate);
  const intent = profileIntent(member.author);
  return (
    <button
      type="button"
      class={`chat-member chat-member-${member.role}${self ? " self" : ""}${blocked ? " blocked" : ""}${member.nameplate ? " has-nameplate" : ""}`}
      {...intent}
      onClick={() => onOpen(member)}
      onMouseEnter={decorated ? () => setHovered(true) : undefined}
      onMouseLeave={decorated ? () => setHovered(false) : undefined}
      onFocus={() => {
        intent.onFocus();
        if (decorated) setHovered(true);
      }}
      onBlur={decorated ? () => setHovered(false) : undefined}
    >
      {member.nameplate && <MemberNameplate id={member.nameplate} active={hovered} />}
      <span class="chat-member-face">
        <ChatAvatar member={member} size={32} decoration={member.decoration} animate={hovered} />
        {online && <span class="chat-member-dot" />}
      </span>
      <span class="chat-member-text">
        <span class="chat-member-name"><ChatDisplayName member={member} /></span>
        {online && member.status && <span class="chat-member-status">{member.status}</span>}
      </span>
    </button>
  );
});

type TextDraft = Record<TextField, string>;
type MediaDraft = Partial<Record<ChatMediaKind, { blob: Blob; url: string } | null>>;
type CosmeticDraft = Partial<Record<ChatCosmeticSlot, string | null>>;
type ProfileColorDraft = Partial<Record<ChatProfileColor, string | null>>;

const COSMETIC_LABELS: Record<ChatCosmeticSlot, string> = {
  decoration: "avatar decoration",
  effect: "profile effect",
  nameplate: "nameplate",
  frame: "profile frame",
};

type EditTab = "profile" | "name" | ChatCosmeticSlot;

const EDIT_TABS: Array<{ key: EditTab; label: string }> = [
  { key: "profile", label: "profile" },
  { key: "name", label: "name style" },
  { key: "nameplate", label: "nameplate" },
  { key: "decoration", label: "avatar decoration" },
  { key: "effect", label: "profile effect" },
  { key: "frame", label: "frame" },
];

function withCosmetics(profile: Profile, draft: CosmeticDraft): Profile {
  const next: Profile = { ...profile };
  for (const slot of CHAT_COSMETIC_SLOTS) {
    const value = draft[slot];
    if (value) next[slot] = value;
    else if (value === null) delete next[slot];
  }
  return next;
}

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
  online: boolean;
  voiceChannel: ChatVoiceChannel | null;
  loadProfile: (id: string, fresh?: boolean) => Promise<Profile | null>;
  moderate: (type: ChatModeration, target: string, extra?: Record<string, unknown>) => Promise<ChatResult>;
  saveProfile: (fields: ChatProfileEdit) => Promise<ChatResult>;
  uploadMedia: (kind: ChatMediaKind, image: Blob) => Promise<ChatResult>;
  onMention: (name: string) => void;
  onMessage: (member: ChatMember) => Promise<ChatResult>;
  onToggleBlock: (member: ChatMember) => void;
  onClose: () => void;
  tutorialStage?: TutorialProfileStage | undefined;
}

export default function ChatProfile({
  author,
  fallback,
  viewer,
  blocked,
  online,
  voiceChannel,
  loadProfile,
  moderate,
  saveProfile,
  uploadMedia,
  onMention,
  onMessage,
  onToggleBlock,
  onClose,
  tutorialStage,
}: ChatProfileProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(() => (tutorialStage ? null : (cachedProfile(author) ?? null)));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useChatDialogNotice();
  const [profileDraft, setDraft] = useState<TextDraft | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaDraft>({});
  const [nameStyle, setNameStyle] = useState<ChatNameStyleDraft>({});
  const [colorPicking, setColorPicking] = useState<"nameColor" | ChatProfileColor | null>(null);
  const [cosmetics, setCosmetics] = useState<CosmeticDraft>({});
  const [profileColors, setProfileColors] = useState<ProfileColorDraft>({});
  const [tab, setTab] = useState<EditTab>("profile");
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
    closeOnEscape: !tutorialStage && !colorPicking,
    closeOnOverlay: !tutorialStage && !colorPicking,
    useOverlay: !tutorialStage,
  });

  const refresh = useCallback((fresh = false) => {
    void loadProfile(author, fresh).then((next) => setProfile((current) => next ?? current));
  }, [author, loadProfile]);

  useEffect(() => {
    if (!tutorialStage) refresh();
  }, [refresh, tutorialStage]);

  useEffect(
    () => () => {
      for (const pick of Object.values(mediaRef.current)) if (pick) URL.revokeObjectURL(pick.url);
    },
    [],
  );

  const shown: Profile = profile ?? { ...fallback, joinedAt: 0 };
  const self = viewer.author === author;
  const draft = tutorialStage === "edit" ? draftOf(shown) : profileDraft;
  const editing = self && !!draft;
  const splitEditor = useSplitEditor();
  const split = editing && splitEditor;
  const timeoutAllowed = !self && canTimeout(viewer.role, shown.role);
  const banAllowed = !self && canBan(viewer.role, shown.role);
  const voiceAllowed = !self && !!voiceChannel && canTimeout(viewer.role, shown.role);
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
  const avatarTint = !avatarUrl ? undefined : sampled?.src === avatarUrl ? sampled.color : sampledAvatarColor(avatarUrl);
  const bannerColor = !avatarUrl ? letterColor : avatarTint === undefined ? null : (avatarTint ?? letterColor);

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
    setCosmetics({});
    setNameStyle({});
    setProfileColors({});
    setTab("profile");
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
      refresh(true);
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
    for (const slot of CHAT_COSMETIC_SLOTS) {
      const value = cosmetics[slot];
      if (value !== undefined && value !== (shown[slot] ?? null)) fields[slot] = value;
    }
    for (const field of CHAT_NAME_STYLE_FIELDS) {
      const value = nameStyle[field];
      if (value !== undefined && value !== (shown[field] ?? null)) fields[field] = value;
    }
    for (const field of CHAT_PROFILE_COLORS) {
      const value = profileColors[field];
      if (value !== undefined && value !== (shown[field] ?? null)) fields[field] = value;
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
  }, [cosmetics, draft, media, nameStyle, profileColors, saveProfile, shown, stopEditing, uploadMedia]);

  const look = editing ? withCosmetics(previewOf(shown, draft), cosmetics) : shown;
  if (editing) {
    for (const field of CHAT_NAME_STYLE_FIELDS) {
      const value = nameStyle[field];
      if (value) look[field] = value;
      else if (value === null) delete look[field];
    }
    for (const field of CHAT_PROFILE_COLORS) {
      const value = profileColors[field];
      if (value) look[field] = value;
      else if (value === null) delete look[field];
    }
  }
  const themePrimary = look.accent ?? look.accentSecondary;
  const themeSecondary = look.accentSecondary ?? look.accent;
  const themeText = themePrimary && themeSecondary ? (prefersDarkText([themePrimary, themeSecondary]) ? "dark" : "light") : undefined;
  const frame = useCosmetics(!!look.frame)?.find("frame", look.frame);
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
          upload
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

  const profileColorField = (field: ChatProfileColor) => {
    const value = look[field];
    return (
      <div class="chat-profile-field">
        <label>{PROFILE_COLOR_LABELS[field]}</label>
        <div class="chat-profile-row">
          <button
            type="button"
            class="chat-secondary-btn chat-profile-color-pick"
            aria-haspopup="dialog"
            aria-label={value ? `${PROFILE_COLOR_LABELS[field]} ${value}` : PROFILE_COLOR_LABELS[field]}
            disabled={busy}
            onClick={() => setColorPicking(field)}
          >
            <span class={`chat-color-dot${value ? "" : " is-custom"}`} style={value ? { background: value } : undefined} />
            choose
          </button>
          <button
            type="button"
            class="chat-secondary-btn"
            disabled={busy || !value}
            onClick={() => setProfileColors((current) => ({ ...current, [field]: null }))}
          >
            remove
          </button>
        </div>
      </div>
    );
  };

  const cosmeticField = (slot: ChatCosmeticSlot) => {
    const label = COSMETIC_LABELS[slot];
    return (
      <div class="chat-profile-field">
        <CosmeticPicker
          key={slot}
          slot={slot}
          label={label}
          value={look[slot]}
          member={look}
          disabled={busy}
          onPick={(id) => setCosmetics((current) => ({ ...current, [slot]: id }))}
        />
        <div class="chat-profile-row">
          <button
            type="button"
            class="chat-secondary-btn"
            disabled={busy || !look[slot]}
            onClick={() => setCosmetics((current) => ({ ...current, [slot]: null }))}
          >
            remove {label}
          </button>
        </div>
      </div>
    );
  };

  const pickNameStyle = (field: ChatNameStyleField, id: string, fallback: string) =>
    setNameStyle((current) => ({ ...current, [field]: id === fallback ? null : id }));

  const nameChoices = (field: "nameFont" | "nameEffect", label: string, options: ReadonlyArray<{ id: string; label: string }>, fallback: string) => (
    <div class="chat-profile-field">
      <label id={`chat-name-${field}`}>{label}</label>
      <div class={`chat-profile-row chat-name-options is-${field}`} role="group" aria-labelledby={`chat-name-${field}`}>
        {options.map((option) => {
          const selected = (look[field] ?? fallback) === option.id;
          return (
            <button
              type="button"
              key={option.id}
              class={selected ? "" : "chat-secondary-btn"}
              aria-pressed={selected}
              disabled={busy}
              onClick={() => pickNameStyle(field, option.id, fallback)}
            >
              <ChatDisplayName member={{ ...look, [field]: option.id }} label={option.label} />
            </button>
          );
        })}
      </div>
    </div>
  );

  const nameColor = look.nameColor ?? "default";
  const colorSwatch = (id: string, label: string) => (
    <button
      type="button"
      key={id}
      class="chat-tool chat-color-swatch"
      aria-label={label}
      aria-pressed={nameColor === id}
      data-tooltip={label}
      disabled={busy}
      onClick={() => pickNameStyle("nameColor", id, "default")}
    >
      <span class={`chat-color-dot${id === "default" ? " is-default" : ""}`} style={id === "default" ? undefined : { background: chatNameSwatch(id) }} />
    </button>
  );

  const nameColors = (
    <div class="chat-profile-field">
      <label id="chat-name-nameColor">color</label>
      <div class="chat-color-swatches" role="group" aria-labelledby="chat-name-nameColor">
        {colorSwatch("default", "default")}
        {CHAT_NAME_SOLIDS.map((color) => colorSwatch(color.id, color.label))}
        <button
          type="button"
          class="chat-tool chat-color-swatch"
          aria-label={isCustomNameColor(nameColor) ? `custom color ${nameColor}` : "custom color"}
          aria-pressed={isCustomNameColor(nameColor)}
          aria-haspopup="dialog"
          data-tooltip="custom color"
          disabled={busy}
          onClick={() => setColorPicking("nameColor")}
        >
          <span class="chat-color-dot is-custom" style={isCustomNameColor(nameColor) ? { "--custom-color": chatNameSwatch(nameColor) } : undefined} />
        </button>
      </div>
      <p class="chat-panel-title chat-color-group-title">gradients</p>
      <div class="chat-color-swatches" role="group" aria-label="gradients">
        {CHAT_NAME_PALETTES.map((color) => colorSwatch(color.id, color.label))}
      </div>
    </div>
  );

  const editorTabs = (
    <SeasonTabs
      options={EDIT_TABS.map((option) => ({
        key: option.key,
        label: option.label,
        active: tab === option.key,
        onSelect: () => setTab(option.key),
      }))}
    />
  );

  const editorFields = editing && (
    <>
      {tab === "profile" ? (
        <>
          {text("display")}
          {text("bio")}
          <div class="chat-profile-images">
            {profileColorField("accent")}
            {profileColorField("accentSecondary")}
          </div>
          <div class="chat-profile-images">
            {image("avatar", "avatar")}
            {image("banner", "banner")}
          </div>
        </>
      ) : tab === "name" ? (
        <>
          <div class="chat-name-styles">
            {nameColors}
            {nameChoices("nameEffect", "effect", CHAT_NAME_EFFECTS, "none")}
            {nameChoices("nameFont", "font", CHAT_NAME_FONTS, "default")}
          </div>
          <div class="chat-profile-row">
            <button type="button" class="chat-secondary-btn" disabled={busy} onClick={() => setNameStyle({ nameFont: null, nameEffect: null, nameColor: null })}>
              reset name style
            </button>
          </div>
        </>
      ) : (
        cosmeticField(tab)
      )}
      <div class="chat-profile-savebar">
        {notice && (
          <p class="chat-profile-notice" data-tone={notice.tone} aria-live="polite">
            {notice.text}
          </p>
        )}
        <div class="chat-profile-actions">
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "saving..." : "save"}
          </button>
          <button type="button" class="chat-secondary-btn" disabled={busy} onClick={stopEditing}>
            cancel
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => void pickImage(event)} />
    </>
  );

  return (
    <>
      <div
        id="chat-profile-modal"
        data-tutorial-preview={tutorialStage}
        class={`popup chat-profile${split ? " is-split" : ""} ${modalStateClass}`}
        style={{
          "--chat-card-accent": themePrimary ?? bannerColor ?? undefined,
          "--chat-theme-primary": themePrimary,
          "--chat-theme-secondary": themeSecondary,
          "--profile-frame-side": frame ? 2 * frame.side / frame.inner : 0,
          "--profile-frame-overflow": frame ? (frame.top + frame.bottom) / frame.inner : 0,
          "--profile-frame-offset": frame ? (frame.top - frame.bottom) / frame.inner : 0,
        }}
        onAnimationEnd={onAnimationEnd}
      >
        <div class="chat-profile-stage">
          <ProfileFrame id={look.frame} front={false} />
          <div class={`chat-profile-card${editing && !split && tab !== "profile" && tab !== "name" ? " is-picking" : ""}${themePrimary ? " has-theme" : ""}`} data-theme-text={themeText}>
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
                <ChatAvatar member={look} size={84} src={avatarSrc} decoration={look.decoration} animate />
                {editing && (
                  <span class="chat-card-avatar-edit">
                    <IconPencil size={22} />
                  </span>
                )}
                {online && <span class="chat-member-dot chat-card-dot" />}
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
                online && look.status && (
                  <p class="chat-card-status" title={look.status}>
                    <span>{look.status}</span>
                  </p>
                )
              )}
            </div>
            <div class="chat-card-title">
              <h2>
                <ChatDisplayName member={look} />
                <RoleBadge role={shown.role} />
              </h2>
              {self && !editing && (
                <button
                  type="button"
                  class="chat-card-edit"
                  onClick={() => setDraft({ ...draftOf(shown), status: statusValue })}
                >
                  <IconPencil size={13} />
                  edit profile
                </button>
              )}
            </div>
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
            {editing && !split && editorTabs}
            <div class="input-container">
              {editing && !split ? (
                editorFields
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

              {voiceAllowed && voiceChannel && (
                <div class="chat-profile-field">
                  <label>voice</label>
                  <p class="chat-profile-hint">they are in {CHAT_VOICE_NAMES[voiceChannel]}. kicking ends their call.</p>
                  <div class="chat-profile-row">
                    <button
                      type="button"
                      class="chat-secondary-btn"
                      disabled={busy}
                      onClick={() => void run("voicekick", {}, `${shown.name} is kicked from voice`)}
                    >
                      kick from vc
                    </button>
                  </div>
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

              {notice && !editing && (
                <p class="chat-profile-notice" data-tone={notice.tone} aria-live="polite">
                  {notice.text}
                </p>
              )}
            </div>
          </div>
          <ProfileEffect key={look.effect} id={look.effect} />
          <ProfileFrame id={look.frame} front />
        </div>
        {split && (
          <div class={`chat-profile-editor${tab === "name" ? " is-naming" : tab !== "profile" ? " is-picking" : ""}`}>
            <h2>edit profile</h2>
            {editorTabs}
            <div class="input-container">{editorFields}</div>
          </div>
        )}
        <button type="button" class="modal-close-btn" aria-label="close" onClick={requestClose}>
          <IconCrossMedium />
        </button>
      </div>
      {colorPicking === "nameColor" && (
        <ChatColorPicker
          value={look.nameColor}
          member={look}
          onPick={(color) => pickNameStyle("nameColor", color, "default")}
          onClose={() => setColorPicking(null)}
        />
      )}
      {colorPicking && colorPicking !== "nameColor" && (
        <ChatColorPicker
          title={PROFILE_COLOR_LABELS[colorPicking]}
          value={look[colorPicking]}
          onPick={(color) => setProfileColors((current) => ({ ...current, [colorPicking]: color }))}
          onClose={() => setColorPicking(null)}
        />
      )}
    </>
  );
}
