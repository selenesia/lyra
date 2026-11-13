import { lazy, Suspense } from "preact/compat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { negativeMessage, positiveMessage } from "../../core/runtime/messages.ts";
import { app } from "../../core/runtime/app.ts";
import { appPath } from "../../core/runtime/hosting.ts";
import { chatViewSignal } from "../../core/ui/uiSignals.ts";
import { isManagedModalOpen } from "../../core/ui/modal.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import { loadTutorial, loadCloudSync } from "../../app/loaders.ts";
import { blockedNotice } from "../../features/chat/moderationNotice.ts";
import { mentionsName } from "../../features/chat/chatText.ts";
import { encodeChatImage } from "../../features/chat/chatMedia.ts";
import { partyMediaOf, partyQuery, usePartyTitles, type ChatPartyTitle } from "../../features/chat/chatParty.ts";
import { canDeleteAny, CHAT_ROLES, isChatRole, outranks, type ChatRole } from "../../features/chat/chatRoles.ts";
import {
  CHAT_CATEGORIES,
  CHAT_LIMITS,
  CHAT_ATTACHMENT,
  CHAT_PARTY_COMMAND,
  canPostIn,
  canReadChannel,
  cleanChatText,
  conversationTitle,
  displayName,
  isChatChannel,
  isConversationKey,
  noticeText,
  partyPlayerPath,
  type ChatChannel,
  type ChatConversation,
  type ChatConversationKey,
  type ChatMember,
  type ChatParty,
  type ChatTarget,
} from "../../features/chat/chatProtocol.ts";
import {
  useChatRoom,
  type ChatAccess,
  type ChatEntry,
  type ChatModeration,
  type ChatResult,
} from "../../features/chat/chatRoom.ts";
import {
  IconArrowLeft,
  IconChat,
  IconChevronBottom,
  IconCrossMedium,
  IconPencil,
  IconPeople,
  IconPlusMedium,
} from "../icons";
import IconBase from "../icons/IconBase.tsx";
import { ICON_PATHS, type CanonicalIconName } from "../icons/paths.ts";
import EditableField from "../EditableField.tsx";
import ChatMessage, { type ChatMessageActions } from "./ChatMessage.tsx";
import ChatProfile, { ChatMemberRow, RoleBadge } from "./ChatProfile.tsx";
import ChatAvatar from "./ChatAvatar.tsx";
import ChatTooltip from "./ChatTooltip.tsx";
import ChatConversationModal, { type ChatConversationDialog } from "./ChatConversationModal.tsx";
import "../../assets/styles/chat/chat.css";

const SVG_CHAT = svgIcon("IconChat", { solid: true });
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");
const CHANNEL_ICONS: Partial<Record<ChatChannel, CanonicalIconName>> = {
  rules: "IconBook",
  announcements: "IconMegaphone",
  updates: "IconMegaphone",
};
const GROUP_WINDOW_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 60;
const TYPING_SEND_MS = 2_500;
const DRAFT_CHECK_MS = 300;
const MENTION_QUERY = /(?:^|[\s([{])@([\p{L}\p{N}._-]*)$/u;
const ROLE_COMMAND = /^\/role(?=\s|$)/i;
const ROLE_ARGUMENTS = /^\/role\s+@?(\w+)\s+(\w+)$/i;
const Tutorial = lazy(loadTutorial);

const PARTY_USAGE = "use /party or /watch followed by a title, then pick one from the list";
const CONFIRM_MS = 3_000;
const NO_ENTRIES: ChatEntry[] = [];
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ROLE_HEADINGS: Record<ChatRole, string> = { owner: "owner", admin: "admins", mod: "mods", member: "online" };

type ComposerMode = { kind: "reply" | "edit"; entry: ChatEntry } | null;

function dayLabel(at: number): string {
  const day = new Date(at).toDateString();
  const today = new Date();
  if (day === today.toDateString()) return "today";
  today.setDate(today.getDate() - 1);
  if (day === today.toDateString()) return "yesterday";
  return dayFormat.format(at).toLowerCase();
}

function typingLabel(names: string[]): string {
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are typing...`;
  return "several people are typing...";
}

function placeCaretAtEnd(field: HTMLElement | null): void {
  if (!field || !field.isContentEditable) return;
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function ConversationIcon({ conversation, viewerAuthor }: { conversation: ChatConversation; viewerAuthor: string }) {
  const others = conversation.members.filter((member) => member.author !== viewerAuthor);
  if (conversation.kind === "dm") {
    const other = others[0] ?? conversation.members[0];
    return other ? <ChatAvatar member={other} size={20} /> : <IconPeople size={16} class="chat-channel-icon chat-conversation-icon" />;
  }
  if (others.length < 2) return <IconPeople size={16} class="chat-channel-icon chat-conversation-icon" />;
  return (
    <span class="chat-conversation-faces">
      <ChatAvatar member={others[0]!} size={14} />
      <ChatAvatar member={others[1]!} size={14} />
    </span>
  );
}

function PartyPoster({ src }: { src: string | undefined }) {
  return (
    <span class="chat-suggestion-poster">
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}

function openLogin(): void {
  void loadCloudSync().then(() => {
    if (!isManagedModalOpen(document.getElementById("cloudsync-modal"))) {
      document.dispatchEvent(new CustomEvent("toggleCloudSyncModal"));
    }
  });
}

function AccessGate({ access, onRetry }: { access: ChatAccess; onRetry: () => void }) {
  if (access.state === "checking" || access.state === "signedOut") return null;

  let title = "";
  let detail = "";
  let action: { label: string; run: () => void } | null = null;
  if (access.state === "banned") {
    title = negativeMessage("you are banned from chat");
    detail = [
      access.until ? `until ${timeFormat.format(access.until).toLowerCase()}` : "",
      access.reason ? `reason: ${access.reason}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (access.state === "usernameBlocked") {
    title = negativeMessage("your username is not allowed in chat");
    detail = "make a new cloud sync account with a different name to chat";
  } else if (access.state === "unavailable") {
    title = negativeMessage("chat is unavailable right now");
    action = { label: "try again", run: onRetry };
  }
  return (
    <div class="chat-gate">
      <IconChat size={28} />
      <p class="chat-gate-title">{title}</p>
      {detail && <p class="chat-gate-detail">{detail}</p>}
      {action && (
        <div class="input-container chat-gate-actions">
          <button type="button" onClick={action.run}>
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ChatPage({ openOnMount = false }: { openOnMount?: boolean }) {
  const [target, setTarget] = useState<ChatTarget>("general");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<Blob | null>(null);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [profile, setProfile] = useState<ChatMember | null>(null);
  const [dialog, setDialog] = useState<ChatConversationDialog | null>(null);
  const [startingParty, setStartingParty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [now, setNow] = useState(Date.now);
  const listRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const channelsRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollingToBottomRef = useRef(false);
  const scrollTargetRef = useRef<ChatTarget | null>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const typingSentRef = useRef(0);
  const caretToEndRef = useRef(false);
  const modeRef = useRef<ComposerMode>(null);
  modeRef.current = mode;

  const focusField = useCallback(() => placeCaretAtEnd(fieldRef.current), []);
  const focusFieldAfterRender = useCallback(() => {
    caretToEndRef.current = true;
  }, []);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    stickToBottomRef.current = true;
    anchorRef.current = null;
    const list = listRef.current;
    if (list) {
      scrollingToBottomRef.current = behavior !== "instant" && list.scrollHeight - list.clientHeight - list.scrollTop > 1;
      list.scrollTo({ top: list.scrollHeight, behavior });
    }
  }, []);
  const interruptScroll = useCallback(() => {
    if (!scrollingToBottomRef.current) return;
    scrollingToBottomRef.current = false;
    stickToBottomRef.current = false;
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollTop, behavior: "instant" });
  }, []);

  const cancelMode = useCallback(() => {
    if (sendingRef.current) return false;
    if (!modeRef.current) return false;
    if (modeRef.current.kind === "edit") setDraft("");
    setMode(null);
    setHint(null);
    return true;
  }, []);

  const { visible, searchBarRef, show, hide, toggle } = useMenuView({
    bodyClass: "chat-view",
    signal: chatViewSignal,
    iconId: "chat-icon",
    inactiveIcon: SVG_CHAT,
    activeIcon: SVG_SEARCH,
    openedStorageKey: "lyraUserOpenedChat",
    hideOtherViews: () => {
      window.hideGameMenu?.();
      window.hideWatchMenu?.();
      window.hideSettingsPage?.();
    },
    interceptEscape: cancelMode,
    onShowFrame: focusField,
    showOnMount: openOnMount,
  });

  const room = useChatRoom({ target, visible });
  const { access, viewer, history, exhausted, members, conversations, parties, typing, status, unread, blocked } = room;
  const blockedAuthors = useMemo(() => new Set(blocked.map((member) => member.author)), [blocked]);
  const onlineAuthors = useMemo(() => new Set(members.map((member) => member.author)), [members]);
  const channel: ChatChannel | null = isChatChannel(target) ? target : null;
  const conversation = useMemo(
    () => (isConversationKey(target) ? conversations.find((entry) => entry.key === target) : undefined),
    [conversations, target],
  );
  const loaded = history[target];
  const entries = loaded ?? NO_ENTRIES;
  const mentionMembers = useMemo(() => {
    const known = new Map<string, ChatMember>();
    for (const messages of Object.values(history)) {
      for (const member of messages ?? NO_ENTRIES) known.set(member.name.toLowerCase(), member);
    }
    if (viewer) known.set(viewer.name.toLowerCase(), viewer);
    for (const entry of conversations) {
      for (const member of entry.members) known.set(member.name.toLowerCase(), member);
    }
    for (const member of members) known.set(member.name.toLowerCase(), member);
    return known;
  }, [conversations, history, members, viewer]);
  const ready = access.state === "ready" && !!viewer;
  const mutedUntil = viewer?.mutedUntil ?? 0;
  const muted = mutedUntil > now;
  const locked = !!viewer && !!channel && !canPostIn(viewer.role, channel);
  const others = useMemo(
    () => conversation?.members.filter((member) => member.author !== viewer?.author) ?? [],
    [conversation, viewer?.author],
  );
  const partner = conversation?.kind === "dm" ? (others[0] ?? conversation.members[0]) : undefined;
  const title = channel ? `#${channel}` : conversation && viewer ? conversationTitle(conversation, viewer.author) : "";
  const targetGone = !!viewer && (channel ? !canReadChannel(viewer.role, channel) : !conversation);
  useLayoutEffect(() => {
    if (!targetGone) return;
    setTarget("general");
    setDraft("");
    setAttachment(null);
    setMode(null);
    setSelectedId(null);
    stickToBottomRef.current = true;
  }, [targetGone]);

  useEffect(() => {
    const text = cleanChatText(draft);
    if (!ready || locked || muted || !text || text.startsWith("/")) {
      setDraftWarning(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void room.checkDraft(text).then((category) => {
        if (!current || category === undefined) return;
        setDraftWarning(category ? negativeMessage(blockedNotice("message", category, "would be")) : null);
      });
    }, DRAFT_CHECK_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draft, locked, muted, ready, room.checkDraft]);

  useEffect(() => {
    if (!attachment) {
      setAttachmentUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment);
    setAttachmentUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  const pickImage = async (file: File | undefined) => {
    if (!file || locked || muted || sendingRef.current || preparingImage || mode?.kind === "edit") return;
    setPreparingImage(true);
    try {
      const result = await encodeChatImage(file, "message");
      if ("error" in result) {
        setHint(negativeMessage(result.error === "too_large"
          ? `that image is too large, gifs must fit within ${CHAT_ATTACHMENT.gif.width}px and ${CHAT_ATTACHMENT.gif.bytes / 1024 / 1024} mb`
          : "that image could not be read"));
        return;
      }
      setAttachment(result.image);
      setHint(null);
      focusFieldAfterRender();
    } catch {
      setHint(negativeMessage("that image could not be read"));
    } finally {
      setPreparingImage(false);
    }
  };

  useEffect(() => {
    window.showChatPage = show;
    window.hideChatPage = hide;
    window.toggleChatPage = toggle;
  }, [show, hide, toggle]);

  useEffect(() => {
    if (!visible || access.state !== "signedOut") return;
    hide();
    openLogin();
  }, [access.state, hide, visible]);

  useEffect(() => {
    if (!mutedUntil || mutedUntil <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), mutedUntil - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [mutedUntil]);

  useEffect(() => {
    if (mutedUntil > Date.now()) setNow(Date.now());
  }, [mutedUntil]);

  useEffect(() => {
    const button = document.getElementById("chat-btn");
    const waiting = Object.values(unread);
    button?.classList.toggle("has-unread", !visible && waiting.length > 0);
    button?.classList.toggle("has-mention", !visible && waiting.some((entry) => entry?.mention));
  }, [unread, visible]);

  useLayoutEffect(() => {
    if (!visible || !ready) return;
    channelsRef.current?.querySelector<HTMLElement>(".chat-channel.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [target, ready, visible]);

  useEffect(() => {
    if (!confirmLeave) return;
    const timer = setTimeout(() => setConfirmLeave(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmLeave]);

  useLayoutEffect(() => {
    if (!caretToEndRef.current) return;
    caretToEndRef.current = false;
    placeCaretAtEnd(fieldRef.current);
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !ready || !list) {
      scrollTargetRef.current = null;
      return;
    }
    if (scrollTargetRef.current !== target) {
      scrollTargetRef.current = target;
      scrollToBottom("instant");
      return;
    }
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      list.scrollTo({ top: anchor.top + (list.scrollHeight - anchor.height), behavior: "instant" });
      return;
    }
    if (stickToBottomRef.current) scrollToBottom();
  }, [entries, visible, target, ready, sending, scrollToBottom]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !list) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [visible, ready, scrollToBottom]);

  const showFailure = useCallback((result: ChatResult) => {
    if (!result.failure) return false;
    setHint(result.failure.error);
    return true;
  }, []);

  const switchTarget = useCallback(
    (next: ChatTarget) => {
      if (sendingRef.current) return;
      setTarget(next);
      setMode(null);
      setSelectedId(null);
      setConfirmLeave(false);
      stickToBottomRef.current = true;
      focusFieldAfterRender();
    },
    [focusFieldAfterRender],
  );

  const openParty = useCallback(
    (party: ChatParty) => {
      hide();
      void app().handleSearch?.(appPath(partyPlayerPath(party)), party.title, party.poster ?? null);
    },
    [hide],
  );

  const messageMember = useCallback(
    async (member: ChatMember) => {
      const result = await room.openDm(member.author);
      if (result.conversation) switchTarget(result.conversation.key);
      return result;
    },
    [room.openDm, switchTarget],
  );

  const leaveConversation = useCallback(
    async (key: ChatConversationKey, kind: ChatConversation["kind"]) => {
      if (kind === "group" && !confirmLeave) {
        setConfirmLeave(true);
        return;
      }
      setConfirmLeave(false);
      showFailure(await room.leaveConversation(key));
    },
    [confirmLeave, room.leaveConversation, showFailure],
  );

  const toggleCategory = useCallback((name: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  const insertMention = useCallback(
    (memberName: string) => {
      if (locked) return;
      setDraft((current) => {
        const replaced = current.replace(MENTION_QUERY, (match) => `${match.startsWith("@") ? "" : match[0]}@${memberName} `);
        return replaced === current ? `${current}${current && !current.endsWith(" ") ? " " : ""}@${memberName} ` : replaced;
      });
      setSuggestionIndex(0);
      focusFieldAfterRender();
    },
    [focusFieldAfterRender, locked],
  );

  const actions = useMemo<ChatMessageActions>(
    () => ({
      reply: (entry) => {
        if (locked || sendingRef.current) return;
        setMode({ kind: "reply", entry });
        setSelectedId(null);
        focusFieldAfterRender();
      },
      edit: (entry) => {
        if (locked || sendingRef.current) return;
        setAttachment(null);
        setMode({ kind: "edit", entry });
        setDraft(entry.text);
        setSelectedId(null);
        focusFieldAfterRender();
      },
      remove: (entry) => {
        if (modeRef.current?.entry.id === entry.id) setMode(null);
        void room.remove(entry.id).then(showFailure);
      },
      react: (entry, emoji) => void room.react(entry.id, emoji).then(showFailure),
      block: (member) => room.toggleBlocked(member),
      jumpTo: (id) => {
        const target = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        if (!target) {
          setHint(negativeMessage("that message is no longer loaded"));
          return;
        }
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.classList.remove("flash");
        void target.offsetWidth;
        target.classList.add("flash");
      },
      openProfile: setProfile,
      openLink: (url) => {
        hide();
        void app().handleSearch?.(url);
      },
      select: setSelectedId,
      joinParty: (invite) => {
        void room.loadParty(invite.id).then((result) => {
          if (result.party) openParty(result.party);
          else showFailure(result);
        });
      },
      endParty: (id) => void room.endParty(id).then(showFailure),
    }),
    [focusFieldAfterRender, hide, locked, openParty, room.endParty, room.loadParty, room.react, room.remove, room.toggleBlocked, showFailure],
  );

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (scrollingToBottomRef.current) {
      if (list.scrollHeight - list.scrollTop - list.clientHeight <= 1) scrollingToBottomRef.current = false;
      return;
    }
    stickToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
    if (list.scrollTop > NEAR_TOP_PX || exhausted[target] || !entries.length) return;
    const anchor = { height: list.scrollHeight, top: list.scrollTop };
    void room.loadOlder(target).then((count) => {
      if (count && !stickToBottomRef.current) anchorRef.current = anchor;
    });
  }, [target, entries.length, exhausted, room.loadOlder]);

  const partyText = ready && !locked && !muted && mode?.kind !== "edit" ? partyQuery(draft) : undefined;
  const picking = partyText !== undefined;
  const partyTitles = usePartyTitles(partyText);
  const mentionQuery = ready && !locked && !picking ? MENTION_QUERY.exec(draft)?.[1] : undefined;
  const suggestions = useMemo(() => {
    if (mentionQuery === undefined) return [];
    const query = mentionQuery.toLowerCase();
    return (conversation ? conversation.members : [...mentionMembers.values()])
      .filter(
        (member) =>
          member.author !== viewer?.author &&
          !blockedAuthors.has(member.author) &&
          (member.name.toLowerCase().startsWith(query) || !!member.display?.toLowerCase().startsWith(query)),
      )
      .slice(0, 5);
  }, [conversation, mentionMembers, blockedAuthors, mentionQuery, viewer?.author]);
  const pickerSize = picking ? partyTitles.titles.length : suggestions.length;
  const pickerIndex = Math.min(picking ? suggestionIndex : Math.max(0, suggestionIndex), pickerSize - 1);

  const runRoleCommand = useCallback(
    async (text: string) => {
      const [, name, role] = ROLE_ARGUMENTS.exec(text) ?? [];
      const wanted = role?.toLowerCase();
      if (!name || !isChatRole(wanted)) {
        setHint(negativeMessage("use /role @name followed by member, mod, or admin"));
        return;
      }
      setDraft("");
      setHint(null);
      const result = await room.assignRole(name, wanted);
      if (showFailure(result)) {
        setDraft((value) => value || text);
        return;
      }
      setNotice(positiveMessage(`${name} is now ${wanted}`));
    },
    [room.assignRole, showFailure],
  );

  const startParty = useCallback(
    async (option: ChatPartyTitle) => {
      if (!ready || muted || locked || sendingRef.current) return;
      const media = partyMediaOf(option.url);
      if (!media) {
        setHint(negativeMessage("that title cannot be watched together"));
        return;
      }
      setHint(null);
      sendingRef.current = true;
      setSending(true);
      setStartingParty(true);
      const result = await room.createParty(target, media.path, media.query);
      sendingRef.current = false;
      setSending(false);
      setStartingParty(false);
      if (showFailure(result)) {
        focusFieldAfterRender();
        return;
      }
      setDraft("");
      setSuggestionIndex(0);
      scrollToBottom();
      if (result.party) openParty(result.party);
    },
    [focusFieldAfterRender, locked, muted, openParty, ready, room.createParty, scrollToBottom, showFailure, target],
  );

  const submitMessage = useCallback(async () => {
    if (!ready || muted || sendingRef.current || preparingImage || (!draft.trim() && !attachment && !mode?.entry.attachment)) return;
    const text = cleanChatText(draft);
    if (text && !attachment && mode?.kind !== "edit" && ROLE_COMMAND.test(text)) {
      await runRoleCommand(text);
      return;
    }
    if (locked) {
      setHint(negativeMessage("only staff can post here"));
      return;
    }
    if (mode?.kind !== "edit" && CHAT_PARTY_COMMAND.test(text)) {
      if (!partyTitles.loading) setHint(negativeMessage(PARTY_USAGE));
      return;
    }
    if (!text && (draft.trim() || (!attachment && !(mode?.kind === "edit" && mode.entry.attachment)))) {
      setHint(negativeMessage(`messages need 1 to ${CHAT_LIMITS.text} characters`));
      return;
    }
    const current = mode;
    setHint(null);
    sendingRef.current = true;
    setSending(true);
    typingSentRef.current = 0;
    if (current?.kind !== "edit") scrollToBottom();
    const result =
      current?.kind === "edit"
        ? text === current.entry.text
          ? {}
          : await room.edit(current.entry.id, text)
        : await room.send(target, text, current?.kind === "reply" ? current.entry.id : undefined, attachment ?? undefined);
    sendingRef.current = false;
    setSending(false);
    if (!showFailure(result)) {
      if (current?.kind !== "edit") scrollToBottom();
      setDraft("");
      setMode(null);
      setAttachment(null);
    }
    focusFieldAfterRender();
  }, [attachment, draft, focusFieldAfterRender, locked, mode, muted, partyTitles.loading, preparingImage, ready, room.edit, room.send, runRoleCommand, scrollToBottom, showFailure, target]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (pickerSize && ["Tab", "Enter", "ArrowUp", "ArrowDown"].includes(event.key) && (event.key !== "Tab" || pickerIndex >= 0)) {
        event.preventDefault();
        if (event.key === "ArrowUp") setSuggestionIndex(pickerIndex < 0 ? pickerSize - 1 : (pickerIndex - 1 + pickerSize) % pickerSize);
        else if (event.key === "ArrowDown") setSuggestionIndex((pickerIndex + 1) % pickerSize);
        else if (picking) {
          if (pickerIndex >= 0) void startParty(partyTitles.titles[pickerIndex]!);
        }
        else insertMention(suggestions[pickerIndex]!.name);
        return;
      }
      if (event.key === "ArrowUp" && !draft && !mode && viewer) {
        const last = [...entries].reverse().find((entry) => entry.author === viewer.author && !entry.pending && !entry.notice && !entry.party);
        if (last) {
          event.preventDefault();
          actions.edit(last);
        }
        return;
      }
      if (event.key === "Enter") void submitMessage();
    },
    [actions, draft, entries, insertMention, mode, partyTitles.titles, picking, pickerIndex, pickerSize, startParty, submitMessage, suggestions, viewer],
  );

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      setSuggestionIndex(-1);
      if (hint) setHint(null);
      if (notice) setNotice(null);
      if (!ready || locked || mode?.kind === "edit" || !value.trim() || value.startsWith("/")) return;
      const time = Date.now();
      if (time - typingSentRef.current < TYPING_SEND_MS) return;
      typingSentRef.current = time;
      room.announceTyping(target);
    },
    [hint, locked, mode, notice, ready, room.announceTyping, target],
  );

  const moderateInChannel = useCallback(
    (type: ChatModeration, author: string, extra: Record<string, unknown> = {}) =>
      room.moderateUser(type, author, { ...extra, ...(channel && { channel }) }),
    [channel, room.moderateUser],
  );

  const memberGroups = useMemo(
    () =>
      CHAT_ROLES.map((role) => ({ role, list: members.filter((member) => member.role === role) })).filter(
        (group) => group.list.length > 0,
      ),
    [members],
  );

  const destination = partner ? `@${partner.name}` : title;
  const startText = partner ? `your messages with ${displayName(partner)}` : title;
  const placeholder = muted
    ? `you are timed out until ${timeFormat.format(mutedUntil).toLowerCase()}`
    : locked
      ? `only staff can post in ${title}`
      : mode?.kind === "edit"
        ? "edit your message"
        : `message ${destination} (˶>⩊<˶)`;
  const typingNames = typing
    .filter((entry) => entry.channel === target && !blockedAuthors.has(entry.author))
    .map((entry) => displayName(mentionMembers.get(entry.name.toLowerCase()) ?? entry));
  const emptyText =
    status === "offline"
      ? negativeMessage("chat is unavailable right now")
      : status === "connecting" && !entries.length
        ? "connecting..."
        : !loaded
          ? "loading..."
          : partner
            ? `this is the start of ${startText}`
            : `this is the start of ${startText}, say hi`;
  const partyStatus = !picking
    ? null
    : partyTitles.loading
      ? { text: "looking for titles", error: false }
      : partyTitles.titles.length
        ? null
        : partyText
          ? { text: negativeMessage("no titles match that search"), error: true }
          : { text: "type a title after the command to search", error: false };
  const idleStatus = partyStatus?.text ?? notice;
  const statusError = !!(hint || draftWarning) || (!sending && !preparingImage && !!partyStatus?.error);
  const statusSuccess = !statusError && !partyStatus && !!notice;

  const editingId = mode?.kind === "edit" ? mode.entry.id : undefined;
  const historyExhausted = exhausted[target];
  const rows = useMemo(() => {
    const rows = [];
    if (entries.length && historyExhausted) {
      rows.push(
        <p class="chat-history-edge" key="edge">
          this is the start of {startText}
        </p>,
      );
    }
    let previous: ChatEntry | undefined;
    let shownDay: string | undefined;
    for (const entry of entries) {
      const day = new Date(entry.at).toDateString();
      if (day !== shownDay) {
        rows.push(
          <div class="chat-divider" key={`day-${day}`}>
            <span>{dayLabel(entry.at)}</span>
          </div>,
        );
        shownDay = day;
        previous = undefined;
      }
      if (entry.notice) {
        rows.push(
          <div class="chat-message chat-notice" key={entry.id} data-id={entry.id}>
            {noticeText(displayName(entry), entry.notice, entry.at)}
          </div>,
        );
        previous = undefined;
        continue;
      }
      if (blockedAuthors.has(entry.author)) {
        rows.push(
          <div class="chat-message chat-blocked" key={entry.id}>
            message from someone you blocked ·{" "}
            <span
              class="link"
              role="button"
              tabIndex={0}
              onClick={() => room.toggleBlocked(entry)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                room.toggleBlocked(entry);
              }}
            >
              unblock {displayName(entry)}
            </span>
          </div>,
        );
        previous = undefined;
        continue;
      }
      const mine = !!viewer && entry.author === viewer.author;
      const grouped =
        !!previous &&
        previous.author === entry.author &&
        previous.name === entry.name &&
        entry.at - previous.at < GROUP_WINDOW_MS;
      rows.push(
        <ChatMessage
          key={entry.nonce && entry.pending ? `local-${entry.nonce}` : entry.id}
          entry={entry}
          grouped={grouped}
          mine={mine}
          canPost={!locked}
          canDelete={mine || (!!channel && !!viewer && canDeleteAny(viewer.role) && outranks(viewer.role, entry.role))}
          author={viewer?.author ?? ""}
          selfName={viewer?.name ?? ""}
          mentionMembers={mentionMembers}
          mentioned={!mine && !!viewer && (mentionsName(entry.text, viewer.name) || entry.reply?.author === viewer.author)}
          selected={selectedId === entry.id}
          editing={editingId === entry.id}
          party={entry.party ? parties[entry.party.id] : undefined}
          actions={actions}
        />,
      );
      previous = entry;
    }
    return rows;
  }, [actions, blockedAuthors, channel, editingId, entries, historyExhausted, locked, mentionMembers, parties, room.toggleBlocked, selectedId, startText, viewer]);

  return (
    <section id="chat-page" ref={pageRef} class={`chat-page${visible ? " is-visible" : ""}${ready ? "" : " is-gated"}`} aria-hidden={!visible}>
      {visible && ready && <ChatTooltip containerRef={pageRef} />}
      {visible && ready && (
        <Suspense fallback={null}>
          <Tutorial guide="chat" />
        </Suspense>
      )}
      {!ready ? (
        <AccessGate access={access} onRetry={room.recheck} />
      ) : (
        <>
          <nav class="chat-channels" aria-label="channels" ref={channelsRef}>
            <div class={`chat-category${collapsed.has("messages") ? " collapsed" : ""}`}>
              <div class="chat-category-head">
                <button
                  type="button"
                  class="chat-category-title"
                  aria-expanded={!collapsed.has("messages")}
                  onClick={() => toggleCategory("messages")}
                >
                  <IconChevronBottom size={12} class="chat-category-chevron" />
                  <span>messages</span>
                </button>
                <button
                  type="button"
                  class="chat-tool chat-category-add"
                  aria-label="new chat"
                  aria-haspopup="dialog"
                  data-tooltip="start a dm or group chat"
                  onClick={() => setDialog({ kind: "new" })}
                >
                  <IconPlusMedium size={18} />
                </button>
              </div>
              {conversations.length === 0 && <p class="chat-category-empty">no conversations yet</p>}
              {conversations.map((entry) => {
                const waiting = unread[entry.key];
                const active = entry.key === target;
                const name = conversationTitle(entry, viewer.author);
                return (
                  <div
                    key={entry.key}
                    class={`chat-channel chat-conversation${active ? " active" : ""}${waiting ? " unread" : ""}`}
                  >
                    <button
                      type="button"
                      class="chat-conversation-open"
                      aria-current={active ? "page" : undefined}
                      onClick={() => switchTarget(entry.key)}
                    >
                      <ConversationIcon conversation={entry} viewerAuthor={viewer.author} />
                      <span class="chat-channel-name">{name}</span>
                      {waiting && (
                        <span class={`chat-badge${waiting.mention ? " mention" : ""}`}>
                          {waiting.count > 99 ? "99+" : waiting.count}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {CHAT_CATEGORIES.map((category) => {
              const channels = category.channels.filter((option) => canReadChannel(viewer.role, option));
              if (!channels.length) return null;
              const folded = collapsed.has(category.name);
              return (
                <div class={`chat-category${folded ? " collapsed" : ""}`} key={category.name}>
                  <button
                    type="button"
                    class="chat-category-title"
                    aria-expanded={!folded}
                    onClick={() => toggleCategory(category.name)}
                  >
                    <IconChevronBottom size={12} class="chat-category-chevron" />
                    <span>{category.name}</span>
                  </button>
                  {channels.map((option) => {
                    const waiting = unread[option];
                    const icon = CHANNEL_ICONS[option];
                    return (
                      <button
                        type="button"
                        key={option}
                        class={`chat-channel${option === channel ? " active" : ""}${waiting ? " unread" : ""}`}
                        aria-current={option === channel ? "page" : undefined}
                        onClick={() => switchTarget(option)}
                      >
                        {icon ? (
                          <IconBase icon={ICON_PATHS[icon]} size={16} class="chat-channel-icon" />
                        ) : (
                          <span class="chat-channel-icon chat-channel-hash">#</span>
                        )}
                        <span class="chat-channel-name">{option}</span>
                        {waiting && (
                          <span class={`chat-badge${waiting.mention ? " mention" : ""}`}>
                            {waiting.mention ? "@" : waiting.count > 99 ? "99+" : waiting.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div class="chat-main">
            <div class="chat-feed" ref={listRef} onScroll={onScroll} onWheel={interruptScroll} onTouchStart={interruptScroll} onPointerDown={interruptScroll} onKeyDown={interruptScroll} onLoadCapture={() => {
              if (stickToBottomRef.current) scrollToBottom();
            }} role="log" aria-live="polite">
              {rows.length ? rows : <p class="chat-empty">{emptyText}</p>}
            </div>
            <p class="chat-typing" aria-live="polite">
              {typingLabel(typingNames)}
            </p>
            <div class="chat-dock">
              {picking && partyTitles.titles.length > 0 && (
                <div class="chat-suggestions chat-party-suggestions" role="listbox" aria-label="titles to watch together">
                  {partyTitles.titles.map((option, index) => (
                    <button
                      type="button"
                      key={option.key}
                      role="option"
                      aria-selected={index === pickerIndex}
                      class={`chat-suggestion${index === pickerIndex ? " active" : ""}`}
                      disabled={sending}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void startParty(option)}
                    >
                      <PartyPoster src={option.poster} />
                      <span class="chat-suggestion-name">{option.title}</span>
                      <span class="chat-suggestion-handle">{option.detail}</span>
                    </button>
                  ))}
                </div>
              )}
              {suggestions.length > 0 && (
                <div class="chat-suggestions" role="listbox">
                  {suggestions.map((member, index) => (
                    <button
                      type="button"
                      key={member.author}
                      role="option"
                      aria-selected={index === pickerIndex}
                      class={`chat-suggestion${index === pickerIndex ? " active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(member.name)}
                    >
                      <ChatAvatar member={member} size={20} />
                      {member.display && <span class="chat-suggestion-name">{member.display}</span>}
                      <span class={member.display ? "chat-suggestion-handle" : undefined}>@{member.name}</span>
                      <RoleBadge role={member.role} />
                    </button>
                  ))}
                </div>
              )}
              {mode && !locked && (
                <div class="chat-context">
                  <span>
                    {mode.kind === "reply" ? (
                      <>
                        replying to <strong>{displayName(mode.entry)}</strong>
                      </>
                    ) : (
                      "editing message · esc to cancel"
                    )}
                  </span>
                  <button type="button" class="chat-context-close" aria-label="cancel" onClick={cancelMode}>
                    <IconCrossMedium size={12} />
                  </button>
                </div>
              )}
              {attachmentUrl && !locked && mode?.kind !== "edit" && (
                <div class="chat-attachment-preview">
                  <img src={attachmentUrl} alt="attachment preview" />
                  <button type="button" class="chat-tool" aria-label="remove attachment" disabled={sending} onClick={() => setAttachment(null)}>
                    <IconCrossMedium size={16} />
                  </button>
                </div>
              )}
              <div
                class={`search-bar chat-bar${muted ? " is-muted" : ""}`}
                ref={searchBarRef}
                onPasteCapture={(event) => {
                  const file = event.clipboardData?.files[0];
                  if (!file) return;
                  event.preventDefault();
                  event.stopPropagation();
                  void pickImage(file);
                }}
              >
                <div class="light-border"></div>
                <div class="light-inset-bg"></div>
                <div class="light"></div>
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void pickImage(file);
                }} />
                <button
                  type="button"
                  class="chat-tool search-icon chat-attach-button"
                  aria-label="attach image or gif"
                  data-tooltip="attach image or gif"
                  disabled={locked || muted || sending || preparingImage || mode?.kind === "edit"}
                  onClick={() => fileRef.current?.click()}
                >
                  <IconPlusMedium size={20} />
                </button>
                <EditableField
                  id="chatInput"
                  multiline
                  fieldRef={fieldRef}
                  label={`message ${destination}`}
                  placeholder={placeholder}
                  value={locked ? "" : draft}
                  disabled={locked || sending}
                  onChange={onDraftChange}
                  onKeyDown={onKeyDown}
                />
              </div>
              <p class={`chat-status${statusError ? " is-error" : statusSuccess ? " is-success" : ""}`} aria-live="polite">
                {hint ??
                  draftWarning ??
                  (sending
                    ? startingParty
                      ? "starting the watch party"
                      : attachment
                        ? "checking image and sending"
                        : "sending"
                    : preparingImage
                      ? "preparing image"
                      : idleStatus)}
              </p>
            </div>
          </div>

          {conversation ? (
            <aside class="chat-members" aria-label="conversation members">
              <div class="chat-member-group">
                <p class="chat-panel-title">
                  {conversation.kind === "dm" ? "direct message" : "members"} · {conversation.members.length}
                </p>
                {conversation.members.map((member) => (
                  <ChatMemberRow
                    key={member.author}
                    member={member}
                    online={onlineAuthors.has(member.author) || member.author === viewer.author}
                    self={member.author === viewer.author}
                    blocked={blockedAuthors.has(member.author)}
                    tag={member.author === viewer.author ? "you" : conversation.owner === member.author && conversation.kind === "group" ? "owner" : undefined}
                    onOpen={setProfile}
                  />
                ))}
              </div>
              <div class="chat-member-group">
                <p class="chat-panel-title">{conversation.kind === "dm" ? "conversation" : "group"}</p>
                {conversation.kind === "group" && (
                  <>
                    <button type="button" class="chat-member chat-member-action" onClick={() => setDialog({ kind: "settings", key: conversation.key, focus: "add" })}>
                      <span class="chat-member-face chat-member-icon">
                        <IconPlusMedium size={16} />
                      </span>
                      <span class="chat-member-text">
                        <span class="chat-member-name">add people</span>
                      </span>
                    </button>
                    <button type="button" class="chat-member chat-member-action" onClick={() => setDialog({ kind: "settings", key: conversation.key, focus: "rename" })}>
                      <span class="chat-member-face chat-member-icon">
                        <IconPencil size={16} />
                      </span>
                      <span class="chat-member-text">
                        <span class="chat-member-name">rename group</span>
                      </span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  class={`chat-member chat-member-action${confirmLeave ? " is-danger" : ""}`}
                  onClick={() => void leaveConversation(conversation.key, conversation.kind)}
                >
                  <span class="chat-member-face chat-member-icon">
                    {conversation.kind === "group" ? <IconArrowLeft size={16} /> : <IconCrossMedium size={16} />}
                  </span>
                  <span class="chat-member-text">
                    <span class="chat-member-name">
                      {conversation.kind === "group" ? (confirmLeave ? "click again to leave" : "leave group") : "close dm"}
                    </span>
                  </span>
                </button>
              </div>
            </aside>
          ) : (
            <aside class="chat-members" aria-label="online members">
              {memberGroups.map((group) => (
                <div class="chat-member-group" key={group.role}>
                  <p class="chat-panel-title">
                    {ROLE_HEADINGS[group.role]} · {group.list.length}
                  </p>
                  {group.list.map((member) => (
                    <ChatMemberRow
                      key={member.author}
                      member={member}
                      online
                      self={member.author === viewer.author}
                      blocked={blockedAuthors.has(member.author)}
                      tag={member.author === viewer.author ? "you" : undefined}
                      onOpen={setProfile}
                    />
                  ))}
                </div>
              ))}
            </aside>
          )}
        </>
      )}
      {dialog && viewer && (
        <ChatConversationModal
          key={dialog.kind === "new" ? "new" : dialog.key}
          dialog={dialog}
          conversation={dialog.kind === "settings" ? conversations.find((entry) => entry.key === dialog.key) : undefined}
          viewer={viewer}
          online={members}
          blocked={blockedAuthors}
          room={room}
          onOpen={switchTarget}
          onOpenProfile={setProfile}
          onClose={() => setDialog(null)}
        />
      )}
      {profile && viewer && (
        <ChatProfile
          key={profile.author}
          author={profile.author}
          fallback={profile}
          viewer={viewer}
          blocked={blockedAuthors.has(profile.author)}
          loadProfile={room.loadProfile}
          moderate={moderateInChannel}
          saveProfile={room.saveProfile}
          uploadMedia={room.uploadMedia}
          onMention={insertMention}
          onMessage={messageMember}
          onToggleBlock={room.toggleBlocked}
          onClose={() => setProfile(null)}
        />
      )}
    </section>
  );
}
