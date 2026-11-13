import type { RefObject } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useManagedModal } from "../../core/ui/modal.ts";
import { negativeMessage, positiveMessage } from "../../core/runtime/messages.ts";
import {
  CHAT_CONVERSATION_LIMITS,
  cleanConversationName,
  conversationTitle,
  displayName,
  type ChatConversation,
  type ChatConversationKey,
  type ChatMember,
  type ChatViewer,
} from "../../features/chat/chatProtocol.ts";
import type { ChatResult, useChatRoom } from "../../features/chat/chatRoom.ts";
import { IconCheckCircle2, IconCrossMedium } from "../icons";
import ChatAvatar from "./ChatAvatar.tsx";
import { ChatMemberRow, RoleBadge } from "./ChatProfile.tsx";

const SEARCH_DELAY_MS = 250;
const CONFIRM_MS = 3_000;
const OPTION_LIMIT = 8;
const SEARCH_LENGTH = 32;

export type ChatConversationDialog =
  | { kind: "new" }
  | { kind: "settings"; key: ChatConversationKey; focus?: "add" | "rename" | undefined };

type ConversationRoom = Pick<
  ReturnType<typeof useChatRoom>,
  "searchUsers" | "openDm" | "createGroup" | "addMembers" | "removeMember" | "renameGroup" | "leaveConversation"
>;

type Notice = { text: string; tone: "error" | "success" } | null;

function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function startsWith(member: ChatMember, query: string): boolean {
  const wanted = query.toLowerCase();
  return member.name.toLowerCase().startsWith(wanted) || !!member.display?.toLowerCase().startsWith(wanted);
}

interface PeoplePickerProps {
  id: string;
  label: string;
  inputRef: RefObject<HTMLInputElement>;
  candidates: ChatMember[];
  excluded: ReadonlySet<string>;
  picked: ChatMember[];
  limit: number;
  disabled: boolean;
  searchUsers: ConversationRoom["searchUsers"];
  onToggle: (member: ChatMember) => void;
}

function PeoplePicker({ id, label, inputRef, candidates, excluded, picked, limit, disabled, searchUsers, onToggle }: PeoplePickerProps) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; users: ChatMember[] } | null>(null);
  const [active, setActive] = useState(0);
  const wanted = query.trim();

  useEffect(() => {
    if (!wanted) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchUsers(wanted, controller.signal).then((users) => {
        if (!controller.signal.aborted) setFound({ query: wanted, users });
      });
    }, SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [searchUsers, wanted]);

  const options = useMemo(() => {
    const seen = new Set(picked.map((member) => member.author));
    const pool = wanted
      ? [...candidates.filter((member) => startsWith(member, wanted)), ...(found?.query === wanted ? found.users : [])]
      : candidates;
    const rest: ChatMember[] = [];
    for (const member of pool) {
      if (seen.has(member.author) || excluded.has(member.author)) continue;
      seen.add(member.author);
      rest.push(member);
    }
    return [...picked, ...rest.slice(0, OPTION_LIMIT)];
  }, [candidates, excluded, found, picked, wanted]);

  const searching = !!wanted && found?.query !== wanted;
  const full = picked.length >= limit;
  const current = Math.max(0, Math.min(active, options.length - 1));
  const optionId = (member: ChatMember) => `${id}-option-${member.author}`;
  const isPicked = (member: ChatMember) => picked.some((entry) => entry.author === member.author);

  const toggle = (member: ChatMember) => {
    const chosen = isPicked(member);
    if (disabled || (!chosen && full)) return;
    onToggle(member);
    if (!chosen && wanted) {
      setQuery("");
      setActive(0);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      toggle(options[current]!);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={`${id}-options`}
        aria-autocomplete="list"
        aria-activedescendant={options[current] ? optionId(options[current]) : undefined}
        value={query}
        maxLength={SEARCH_LENGTH}
        placeholder="search by name"
        autocomplete="off"
        disabled={disabled}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 ? (
        <div id={`${id}-options`} class="chat-picker" role="listbox" aria-label={label} aria-multiselectable="true">
          {options.map((member, index) => {
            const chosen = isPicked(member);
            const unavailable = !chosen && full;
            return (
              <div
                id={optionId(member)}
                key={member.author}
                role="option"
                aria-selected={chosen}
                aria-disabled={unavailable || undefined}
                class={`chat-suggestion${index === current ? " active" : ""}${unavailable ? " is-disabled" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle(member)}
              >
                <ChatAvatar member={member} size={20} />
                {member.display && <span class="chat-suggestion-name">{member.display}</span>}
                <span class={member.display ? "chat-suggestion-handle" : undefined}>@{member.name}</span>
                <RoleBadge role={member.role} />
                {chosen && <IconCheckCircle2 size={16} class="chat-suggestion-check" />}
              </div>
            );
          })}
        </div>
      ) : (
        <p id={`${id}-options`} class="chat-profile-meta chat-picker-empty" aria-live="polite">
          {searching ? "searching..." : wanted ? negativeMessage("no one matches that name") : "no one else is online, search by name"}
        </p>
      )}
    </>
  );
}

interface ChatConversationModalProps {
  dialog: ChatConversationDialog;
  conversation: ChatConversation | undefined;
  viewer: ChatViewer;
  online: ChatMember[];
  blocked: ReadonlySet<string>;
  room: ConversationRoom;
  onOpen: (key: ChatConversationKey) => void;
  onOpenProfile: (member: ChatMember) => void;
  onClose: () => void;
}

export default function ChatConversationModal({
  dialog,
  conversation,
  viewer,
  online,
  blocked,
  room,
  onOpen,
  onOpenProfile,
  onClose,
}: ChatConversationModalProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [picked, setPicked] = useState<ChatMember[]>([]);
  const [groupName, setGroupName] = useState("");
  const [rename, setRename] = useState(conversation?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const closingRef = useRef(false);
  const profileRef = useRef<ChatMember | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const settings = dialog.kind === "settings" ? conversation : undefined;
  const group = settings?.kind === "group" ? settings : undefined;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
  }, []);

  const finish = useCallback(() => {
    onClose();
    if (profileRef.current) onOpenProfile(profileRef.current);
  }, [onClose, onOpenProfile]);

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: true,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: finish,
  });

  useEffect(() => {
    const field = dialog.kind === "new" || dialog.focus === "add" ? searchRef.current : renameRef.current;
    (field ?? renameRef.current ?? closeRef.current)?.focus();
  }, [dialog]);

  useEffect(() => {
    if (dialog.kind === "settings" && !conversation) requestClose();
  }, [conversation, dialog.kind, requestClose]);

  useEffect(() => {
    if (!confirmLeave && !confirmRemove) return;
    const timer = setTimeout(() => {
      setConfirmLeave(false);
      setConfirmRemove(null);
    }, CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmLeave, confirmRemove]);

  const onlineAuthors = useMemo(() => new Set(online.map((member) => member.author)), [online]);
  const excluded = useMemo(() => {
    const authors = new Set(blocked);
    authors.add(viewer.author);
    for (const member of settings?.members ?? []) authors.add(member.author);
    return authors;
  }, [blocked, settings?.members, viewer.author]);
  const limit = CHAT_CONVERSATION_LIMITS.groupMembers - (settings ? settings.members.length : 1);

  const toggle = useCallback((member: ChatMember) => {
    setNotice(null);
    setPicked((current) =>
      current.some((entry) => entry.author === member.author)
        ? current.filter((entry) => entry.author !== member.author)
        : [...current, member],
    );
  }, []);

  const run = useCallback(
    async (action: () => Promise<ChatResult>, success?: string) => {
      setBusy(true);
      setNotice(null);
      const result = await action();
      setBusy(false);
      if (result.failure) {
        setNotice({ text: result.failure.error, tone: "error" });
        return null;
      }
      if (success) setNotice({ text: positiveMessage(success), tone: "success" });
      return result;
    },
    [],
  );

  const start = useCallback(async () => {
    if (!picked.length || busy) return;
    const name = cleanConversationName(groupName);
    if (name === null) {
      setNotice({ text: negativeMessage(`group names can be up to ${CHAT_CONVERSATION_LIMITS.name} characters`), tone: "error" });
      return;
    }
    const people = picked.map((member) => member.author);
    const result = await run(() => (people.length === 1 ? room.openDm(people[0]!) : room.createGroup(name, people)));
    if (!result?.conversation) return;
    onOpen(result.conversation.key);
    requestClose();
  }, [busy, groupName, onOpen, picked, requestClose, room, run]);

  const saveName = useCallback(async () => {
    if (!group || busy) return;
    const name = cleanConversationName(rename);
    if (name === null) {
      setNotice({ text: negativeMessage(`group names can be up to ${CHAT_CONVERSATION_LIMITS.name} characters`), tone: "error" });
      return;
    }
    const result = await run(() => room.renameGroup(group.key, name), name ? "group renamed" : "group name cleared");
    if (result) setRename(result.conversation?.name ?? name);
  }, [busy, group, rename, room, run]);

  const addPeople = useCallback(async () => {
    if (!group || !picked.length || busy) return;
    const count = picked.length;
    const result = await run(() => room.addMembers(group.key, picked.map((member) => member.author)), `${peopleLabel(count)} added`);
    if (result) setPicked([]);
  }, [busy, group, picked, room, run]);

  const removePerson = useCallback(
    async (member: ChatMember) => {
      if (!group || busy) return;
      if (confirmRemove !== member.author) {
        setConfirmRemove(member.author);
        return;
      }
      setConfirmRemove(null);
      await run(() => room.removeMember(group.key, member.author), `${displayName(member)} was removed`);
    },
    [busy, confirmRemove, group, room, run],
  );

  const leave = useCallback(async () => {
    if (!settings || busy) return;
    if (settings.kind === "group" && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    const result = await run(() => room.leaveConversation(settings.key));
    if (result) requestClose();
  }, [busy, confirmLeave, requestClose, room, run, settings]);

  const openProfile = useCallback(
    (member: ChatMember) => {
      profileRef.current = member;
      requestClose();
    },
    [requestClose],
  );

  const title = dialog.kind === "new" ? "new message" : settings ? conversationTitle(settings, viewer.author) : "conversation";
  const unnamed = settings ? conversationTitle({ ...settings, name: "" }, viewer.author) : "";
  const savedName = group?.name ?? "";
  const nameChanged = (cleanConversationName(rename) ?? rename) !== savedName;
  const others = settings?.members.filter((member) => member.author !== viewer.author) ?? [];
  const candidates = online.filter((member) => !excluded.has(member.author));

  const noticeRow = notice && (
    <p class="chat-profile-notice" data-tone={notice.tone} aria-live="polite">
      {notice.text}
    </p>
  );

  const memberRows = (members: ChatMember[]) => (
    <div class="chat-member-group">
      <p class="chat-panel-title">{settings?.kind === "dm" ? "direct message with" : `members · ${members.length}`}</p>
      {members.map((member) => {
        const self = member.author === viewer.author;
        const removable = !!group && group.owner === viewer.author && !self;
        const confirming = confirmRemove === member.author;
        return (
          <div class="chat-conversation-member" key={member.author}>
            <ChatMemberRow
              member={member}
              online={onlineAuthors.has(member.author) || self}
              self={self}
              blocked={blocked.has(member.author)}
              tag={self ? "you" : group?.owner === member.author ? "owner" : undefined}
              onOpen={openProfile}
            />
            {removable && (
              <button
                type="button"
                class={`chat-tool${confirming ? " danger" : ""}`}
                data-tooltip={confirming ? "click again to remove" : `remove ${displayName(member)}`}
                aria-label={confirming ? `confirm remove ${displayName(member)}` : `remove ${displayName(member)}`}
                disabled={busy}
                onClick={() => void removePerson(member)}
              >
                <IconCrossMedium size={16} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      id="chat-conversation-modal"
      class={`popup chat-conversation ${modalStateClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-conversation-title"
      onAnimationEnd={onAnimationEnd}
    >
      <h2 id="chat-conversation-title">{title}</h2>
      {dialog.kind === "new" ? (
        <div class="input-container">
          <div class="chat-profile-field">
            <label for="chat-conversation-people">people</label>
            <p class="chat-profile-hint">
              {picked.length
                ? `${peopleLabel(picked.length)} picked, up to ${limit}`
                : "pick one person for a direct message, or more for a group"}
            </p>
            <PeoplePicker
              id="chat-conversation-people"
              label="people"
              inputRef={searchRef}
              candidates={candidates}
              excluded={excluded}
              picked={picked}
              limit={limit}
              disabled={busy}
              searchUsers={room.searchUsers}
              onToggle={toggle}
            />
          </div>
          {picked.length > 1 && (
            <div class="chat-profile-field">
              <label for="chat-conversation-name">group name</label>
              <input
                id="chat-conversation-name"
                type="text"
                value={groupName}
                maxLength={CHAT_CONVERSATION_LIMITS.name}
                placeholder="optional"
                autocomplete="off"
                disabled={busy}
                onInput={(event) => setGroupName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void start();
                }}
              />
            </div>
          )}
          <div class="chat-profile-actions">
            <button type="button" disabled={busy || !picked.length} onClick={() => void start()}>
              {busy ? "starting..." : picked.length > 1 ? "create group" : "message"}
            </button>
            <button type="button" class="chat-secondary-btn" disabled={busy} onClick={requestClose}>
              cancel
            </button>
          </div>
          {noticeRow}
        </div>
      ) : settings ? (
        <>
          {group && (
            <div class="input-container">
              <div class="chat-profile-field">
                <label for="chat-conversation-rename">group name</label>
                <input
                  ref={renameRef}
                  id="chat-conversation-rename"
                  type="text"
                  value={rename}
                  maxLength={CHAT_CONVERSATION_LIMITS.name}
                  placeholder={unnamed}
                  autocomplete="off"
                  disabled={busy}
                  onInput={(event) => setRename(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (nameChanged) void saveName();
                  }}
                />
                <div class="chat-profile-row">
                  <button type="button" disabled={busy || !nameChanged} onClick={() => void saveName()}>
                    {rename.trim() || !savedName ? "save name" : "clear name"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {memberRows(group ? settings.members : others)}
          <div class="input-container">
            {group && limit > 0 && (
              <div class="chat-profile-field">
                <label for="chat-conversation-add">add people</label>
                <p class="chat-profile-hint">
                  {picked.length ? `${peopleLabel(picked.length)} picked, up to ${limit}` : `this group has room for ${peopleLabel(limit)}`}
                </p>
                <PeoplePicker
                  id="chat-conversation-add"
                  label="add people"
                  inputRef={searchRef}
                  candidates={candidates}
                  excluded={excluded}
                  picked={picked}
                  limit={limit}
                  disabled={busy}
                  searchUsers={room.searchUsers}
                  onToggle={toggle}
                />
                <div class="chat-profile-row">
                  <button type="button" disabled={busy || !picked.length} onClick={() => void addPeople()}>
                    {picked.length ? `add ${peopleLabel(picked.length)}` : "add"}
                  </button>
                </div>
              </div>
            )}
            <div class="chat-profile-field">
              <label>{group ? "leave group" : "close dm"}</label>
              <p class="chat-profile-hint">
                {group
                  ? group.owner === viewer.author
                    ? "the longest member becomes the owner. you can come back if someone adds you."
                    : "you can come back if someone adds you."
                  : "it comes back when a new message arrives."}
              </p>
              <div class="chat-profile-row">
                <button
                  type="button"
                  class={group ? "chat-danger-btn" : "chat-secondary-btn"}
                  disabled={busy}
                  onClick={() => void leave()}
                >
                  {group ? (confirmLeave ? "click again to leave" : "leave group") : "close dm"}
                </button>
              </div>
            </div>
            {noticeRow}
          </div>
        </>
      ) : null}
      <button ref={closeRef} type="button" class="modal-close-btn" aria-label="close" onClick={requestClose}>
        <IconCrossMedium />
      </button>
    </div>
  );
}
