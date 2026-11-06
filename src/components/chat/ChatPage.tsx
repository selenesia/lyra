import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { negativeMessage, positiveMessage } from "../../core/runtime/messages.ts";
import { app } from "../../core/runtime/app.ts";
import { chatViewSignal } from "../../core/ui/uiSignals.ts";
import { isManagedModalOpen } from "../../core/ui/modal.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import { loadCloudSync } from "../../app/loaders.ts";
import { blockedNotice, moderate } from "../../features/chat/moderation.ts";
import { mentionsName } from "../../features/chat/chatText.ts";
import { canDeleteAny, CHAT_ROLES, isChatRole, outranks, type ChatRole } from "../../features/chat/chatRoles.ts";
import {
  CHAT_CATEGORIES,
  CHAT_LIMITS,
  canPostIn,
  cleanChatText,
  displayName,
  type ChatChannel,
  type ChatMember,
} from "../../features/chat/chatProtocol.ts";
import {
  useChatRoom,
  type ChatAccess,
  type ChatEntry,
  type ChatResult,
} from "../../features/chat/chatRoom.ts";
import { IconBubbleText, IconChevronBottom, IconCrossMedium } from "../icons";
import IconBase from "../icons/IconBase.tsx";
import { ICON_PATHS, type CanonicalIconName } from "../icons/paths.ts";
import EditableField from "../EditableField.tsx";
import ChatMessage, { type ChatMessageActions } from "./ChatMessage.tsx";
import ChatProfile, { RoleBadge } from "./ChatProfile.tsx";
import ChatAvatar from "./ChatAvatar.tsx";
import "../../assets/styles/chat/chat.css";

const SVG_CHAT = svgIcon("IconBubbleText", { solid: true });
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
const MENTION_QUERY = /(?:^|[\s([{])@([\p{L}\p{N}._-]*)$/u;
const ROLE_COMMAND = /^\/role(?=\s|$)/i;
const ROLE_ARGUMENTS = /^\/role\s+@?(\w+)\s+(\w+)$/i;
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ROLE_HEADINGS: Record<ChatRole, string> = { owner: "owner", admin: "admins", mod: "mods", member: "online" };

type ComposerMode = { kind: "reply" | "edit"; entry: ChatEntry } | null;

function checkLocally(value: string): string | null {
  const verdict = moderate(value);
  if (verdict.allowed || !verdict.category) return null;
  return negativeMessage(blockedNotice("message", verdict.category, "would be"));
}

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
      <IconBubbleText size={28} />
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
  const [channel, setChannel] = useState<ChatChannel>("general");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [profile, setProfile] = useState<ChatMember | null>(null);
  const [now, setNow] = useState(Date.now);
  const listRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const typingSentRef = useRef(0);
  const caretToEndRef = useRef(false);
  const modeRef = useRef<ComposerMode>(null);
  modeRef.current = mode;

  const focusField = useCallback(() => placeCaretAtEnd(fieldRef.current), []);
  const focusFieldAfterRender = useCallback(() => {
    caretToEndRef.current = true;
  }, []);

  const cancelMode = useCallback(() => {
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
      window.hideAnimeMenu?.();
    },
    interceptEscape: cancelMode,
    onShowFrame: focusField,
    showOnMount: openOnMount,
  });

  const room = useChatRoom({ channel, visible });
  const { access, viewer, history, exhausted, members, typing, status, unread, blocked } = room;
  const blockedAuthors = useMemo(() => new Set(blocked.map((member) => member.author)), [blocked]);
  const entries = history[channel];
  const mentionMembers = useMemo(() => {
    const known = new Map<string, ChatMember>();
    for (const messages of Object.values(history)) {
      for (const member of messages) known.set(member.name.toLowerCase(), member);
    }
    if (viewer) known.set(viewer.name.toLowerCase(), viewer);
    for (const member of members) known.set(member.name.toLowerCase(), member);
    return known;
  }, [history, members, viewer]);
  const ready = access.state === "ready" && !!viewer;
  const mutedUntil = viewer?.mutedUntil ?? 0;
  const muted = mutedUntil > now;
  const locked = !!viewer && !canPostIn(viewer.role, channel);

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
    if (!caretToEndRef.current) return;
    caretToEndRef.current = false;
    placeCaretAtEnd(fieldRef.current);
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      list.scrollTop = anchor.top + (list.scrollHeight - anchor.height);
      return;
    }
    if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [entries, visible, channel, ready, mode, draft, hint, notice]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !list) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [visible, ready]);

  const showFailure = useCallback((result: ChatResult) => {
    if (!result.failure) return false;
    setHint(result.failure.error);
    return true;
  }, []);

  const switchChannel = useCallback(
    (next: ChatChannel) => {
      setChannel(next);
      setMode(null);
      setSelectedId(null);
      stickToBottomRef.current = true;
      focusFieldAfterRender();
    },
    [focusFieldAfterRender],
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
        if (locked) return;
        setMode({ kind: "reply", entry });
        setSelectedId(null);
        focusFieldAfterRender();
      },
      edit: (entry) => {
        if (locked) return;
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
    }),
    [focusFieldAfterRender, hide, locked, room.react, room.remove, room.toggleBlocked, showFailure],
  );

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    stickToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
    if (list.scrollTop > NEAR_TOP_PX || exhausted[channel] || !entries.length) return;
    const anchor = { height: list.scrollHeight, top: list.scrollTop };
    void room.loadOlder(channel).then((count) => {
      if (count) anchorRef.current = anchor;
    });
  }, [channel, entries.length, exhausted, room.loadOlder]);

  const mentionQuery = ready && !locked ? MENTION_QUERY.exec(draft)?.[1] : undefined;
  const suggestions = useMemo(() => {
    if (mentionQuery === undefined) return [];
    const query = mentionQuery.toLowerCase();
    return [...mentionMembers.values()]
      .filter(
        (member) =>
          member.author !== viewer?.author &&
          !blockedAuthors.has(member.author) &&
          (member.name.toLowerCase().startsWith(query) || !!member.display?.toLowerCase().startsWith(query)),
      )
      .slice(0, 5);
  }, [mentionMembers, blockedAuthors, mentionQuery, viewer?.author]);

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

  const submitMessage = useCallback(async () => {
    if (!ready || muted || !draft.trim()) return;
    const text = cleanChatText(draft);
    if (text && mode?.kind !== "edit" && ROLE_COMMAND.test(text)) {
      await runRoleCommand(text);
      return;
    }
    if (locked) {
      setHint(negativeMessage("only staff can post here"));
      return;
    }
    if (!text) {
      setHint(negativeMessage(`messages need 1 to ${CHAT_LIMITS.text} characters`));
      return;
    }
    const blockedText = checkLocally(text);
    if (blockedText) {
      setHint(blockedText);
      return;
    }
    const current = mode;
    setDraft("");
    setHint(null);
    setMode(null);
    typingSentRef.current = 0;
    if (current?.kind !== "edit") stickToBottomRef.current = true;
    const result =
      current?.kind === "edit"
        ? text === current.entry.text
          ? {}
          : await room.edit(current.entry.id, text)
        : await room.send(channel, text, current?.kind === "reply" ? current.entry.id : undefined);
    if (showFailure(result)) {
      setMode(current);
      setDraft((value) => value || text);
    }
  }, [channel, draft, locked, mode, muted, ready, room.edit, room.send, runRoleCommand, showFailure]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (suggestions.length && ["Tab", "Enter", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "ArrowUp") setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        else if (event.key === "ArrowDown") setSuggestionIndex((index) => (index + 1) % suggestions.length);
        else insertMention(suggestions[Math.min(suggestionIndex, suggestions.length - 1)]!.name);
        return;
      }
      if (event.key === "ArrowUp" && !draft && !mode && viewer) {
        const last = [...entries].reverse().find((entry) => entry.author === viewer.author && !entry.pending);
        if (last) {
          event.preventDefault();
          actions.edit(last);
        }
        return;
      }
      if (event.key === "Enter") void submitMessage();
    },
    [actions, draft, entries, insertMention, mode, submitMessage, suggestionIndex, suggestions, viewer],
  );

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      setSuggestionIndex(0);
      if (hint) setHint(null);
      if (notice) setNotice(null);
      if (!ready || locked || mode?.kind === "edit" || !value.trim() || value.startsWith("/")) return;
      const time = Date.now();
      if (time - typingSentRef.current < TYPING_SEND_MS) return;
      typingSentRef.current = time;
      room.announceTyping(channel);
    },
    [channel, hint, locked, mode, notice, ready, room.announceTyping],
  );

  const memberGroups = useMemo(
    () =>
      CHAT_ROLES.map((role) => ({ role, list: members.filter((member) => member.role === role) })).filter(
        (group) => group.list.length > 0,
      ),
    [members],
  );

  const placeholder = muted
    ? `you are timed out until ${timeFormat.format(mutedUntil).toLowerCase()}`
    : locked
      ? `only staff can post in #${channel}`
      : mode?.kind === "edit"
        ? "edit your message"
        : `message #${channel} (˶>⩊<˶)`;
  const typingNames = typing
    .filter((entry) => entry.channel === channel && !blockedAuthors.has(entry.author))
    .map((entry) => entry.name);
  const emptyText =
    status === "offline"
      ? negativeMessage("chat is unavailable right now")
      : status === "connecting" && !entries.length
        ? "connecting..."
        : `this is the start of #${channel}, say hi`;

  const rows = [];
  if (entries.length && exhausted[channel]) {
    rows.push(
      <p class="chat-history-edge" key="edge">
        this is the start of #{channel}
      </p>,
    );
  }
  let previous: ChatEntry | undefined;
  for (const entry of entries) {
    const day = dayLabel(entry.at);
    if (!previous || dayLabel(previous.at) !== day) {
      rows.push(
        <div class="chat-divider" key={`day-${entry.id}`}>
          <span>{day}</span>
        </div>,
      );
      previous = undefined;
    }
    if (blockedAuthors.has(entry.author)) {
      rows.push(
        <div class="chat-message chat-blocked" key={entry.id}>
          message from someone you blocked ·{" "}
          <span class="link" role="button" tabIndex={0} onClick={() => room.toggleBlocked(entry)}>
            unblock {entry.name}
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
        canDelete={mine || (!!viewer && canDeleteAny(viewer.role) && outranks(viewer.role, entry.role))}
        author={viewer?.author ?? ""}
        selfName={viewer?.name ?? ""}
        mentionMembers={mentionMembers}
        mentioned={!mine && !!viewer && (mentionsName(entry.text, viewer.name) || entry.reply?.author === viewer.author)}
        selected={selectedId === entry.id}
        editing={mode?.kind === "edit" && mode.entry.id === entry.id}
        actions={actions}
      />,
    );
    previous = entry;
  }

  return (
    <section id="chat-page" class={`chat-page${visible ? " is-visible" : ""}${ready ? "" : " is-gated"}`} aria-hidden={!visible}>
      {!ready ? (
        <AccessGate access={access} onRetry={room.recheck} />
      ) : (
        <>
          <nav class="chat-channels" aria-label="channels">
            {CHAT_CATEGORIES.map((category) => {
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
                  {category.channels.map((option) => {
                    const waiting = unread[option];
                    const icon = CHANNEL_ICONS[option];
                    return (
                      <button
                        type="button"
                        key={option}
                        class={`chat-channel${option === channel ? " active" : ""}${waiting ? " unread" : ""}`}
                        aria-current={option === channel ? "page" : undefined}
                        onClick={() => switchChannel(option)}
                      >
                        {icon ? (
                          <IconBase icon={ICON_PATHS[icon]} size={18} class="chat-channel-icon" />
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
            <div class="chat-feed" ref={listRef} onScroll={onScroll} role="log" aria-live="polite">
              {rows.length ? rows : <p class="chat-empty">{emptyText}</p>}
            </div>
            <p class="chat-typing" aria-live="polite">
              {typingLabel(typingNames)}
            </p>
            <div class="chat-dock">
              {suggestions.length > 0 && (
                <div class="chat-suggestions" role="listbox">
                  {suggestions.map((member, index) => (
                    <button
                      type="button"
                      key={member.author}
                      role="option"
                      aria-selected={index === suggestionIndex}
                      class={`chat-suggestion${index === suggestionIndex ? " active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(member.name)}
                    >
                      <ChatAvatar member={member} size={20} />
                      {member.display && <span>{member.display}</span>}
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
                        replying to <strong>{mode.entry.name}</strong>
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
              <div class={`search-bar chat-bar${muted ? " is-muted" : ""}`} ref={searchBarRef}>
                <div class="light-border"></div>
                <div class="light-inset-bg"></div>
                <div class="light"></div>
                <EditableField
                  id="chatInput"
                  fieldRef={fieldRef}
                  label={`message #${channel}`}
                  placeholder={placeholder}
                  value={locked ? "" : draft}
                  disabled={locked}
                  onChange={onDraftChange}
                  onKeyDown={onKeyDown}
                />
              </div>
              <p class={`chat-status${hint ? " is-error" : notice ? " is-success" : ""}`} aria-live="polite">
                {hint ?? notice}
              </p>
            </div>
          </div>

          <aside class="chat-members" aria-label="online members">
            {memberGroups.map((group) => (
              <div class="chat-member-group" key={group.role}>
                <p class="chat-panel-title">
                  {ROLE_HEADINGS[group.role]} · {group.list.length}
                </p>
                {group.list.map((member) => (
                  <button
                    type="button"
                    key={member.author}
                    class={`chat-member chat-member-${member.role}${member.author === viewer.author ? " self" : ""}${blockedAuthors.has(member.author) ? " blocked" : ""}`}
                    onClick={() => setProfile(member)}
                  >
                    <span class="chat-member-face">
                      <ChatAvatar member={member} size={32} />
                      <span class="chat-member-dot" />
                    </span>
                    <span class="chat-member-text">
                      <span class="chat-member-name">{displayName(member)}</span>
                      {member.status && <span class="chat-member-status">{member.status}</span>}
                    </span>
                    {member.author === viewer.author && <span class="chat-member-tag">you</span>}
                  </button>
                ))}
              </div>
            ))}
          </aside>
        </>
      )}
      {profile && viewer && (
        <ChatProfile
          key={profile.author}
          author={profile.author}
          fallback={profile}
          viewer={viewer}
          blocked={blockedAuthors.has(profile.author)}
          loadProfile={room.loadProfile}
          moderate={room.moderateUser}
          saveProfile={room.saveProfile}
          uploadMedia={room.uploadMedia}
          onMention={insertMention}
          onToggleBlock={room.toggleBlocked}
          onClose={() => setProfile(null)}
        />
      )}
    </section>
  );
}
