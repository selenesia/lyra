import { memo } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { CHAT_REACTIONS, displayName, type ChatMember } from "../../features/chat/chatProtocol.ts";
import type { ChatEntry } from "../../features/chat/chatRoom.ts";
import { IconArrowCornerUpLeft, IconCrossMedium, IconFaceSmilePlus, IconGhost, IconPencil } from "../icons";
import MessageText from "./MessageText.tsx";
import ChatAvatar from "./ChatAvatar.tsx";
import { RoleBadge } from "./ChatProfile.tsx";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function plainPreview(text: string): string {
  return text.replace(/\|\|.+?(?:\|\||$)/g, "[spoiler]").replace(/\*\*|~~|`/g, "");
}

export interface ChatMessageActions {
  reply: (entry: ChatEntry) => void;
  edit: (entry: ChatEntry) => void;
  remove: (entry: ChatEntry) => void;
  react: (entry: ChatEntry, emoji: string) => void;
  block: (member: ChatMember) => void;
  jumpTo: (id: string) => void;
  openProfile: (member: ChatMember) => void;
  openLink: (url: string) => void;
  select: (id: string | null) => void;
}

interface ChatMessageProps {
  entry: ChatEntry;
  grouped: boolean;
  mine: boolean;
  canPost: boolean;
  canDelete: boolean;
  author: string;
  selfName: string;
  mentionMembers: ReadonlyMap<string, ChatMember>;
  mentioned: boolean;
  selected: boolean;
  editing: boolean;
  actions: ChatMessageActions;
}

function ChatMessage({ entry, grouped, mine, canPost, canDelete, author, selfName, mentionMembers, mentioned, selected, editing, actions }: ChatMessageProps) {
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!selected) {
      setPicking(false);
      setConfirmDelete(false);
    }
  }, [selected]);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3_000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const reactions = Object.entries(entry.reactions ?? {});
  const showMeta = !grouped || !!entry.reply;
  const classes = ["chat-message"];
  if (!showMeta) classes.push("grouped");
  if (entry.pending) classes.push("pending");
  if (mentioned) classes.push("mentioned");
  if (selected) classes.push("is-selected");
  if (editing) classes.push("is-editing");

  return (
    <div
      class={classes.join(" ")}
      data-id={entry.id}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, [role='button']")) return;
        actions.select(selected ? null : entry.id);
      }}
      onMouseLeave={() => {
        if (selected) actions.select(null);
      }}
    >
      {entry.reply && (
        <button
          type="button"
          class={`chat-reply-preview${!mine && entry.reply.author === author ? " self" : ""}`}
          onClick={() => actions.jumpTo(entry.reply!.id)}
        >
          <span class="chat-reply-name">{displayName(mentionMembers.get(entry.reply.name.toLowerCase()) ?? entry.reply)}</span>
          <span class="chat-reply-text">{plainPreview(entry.reply.text)}</span>
        </button>
      )}
      {showMeta && (
        <div class="chat-message-meta">
          <button
            type="button"
            class="chat-message-avatar"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => actions.openProfile(entry)}
          >
            <ChatAvatar member={entry} size={40} />
          </button>
          <button
            type="button"
            class={`chat-message-name${mine ? " mine" : ""}`}
            onClick={() => actions.openProfile(entry)}
          >
            {displayName(entry)}
          </button>
          <RoleBadge role={entry.role} />
          <span class="chat-message-time">{timeFormat.format(entry.at).toLowerCase()}</span>
        </div>
      )}
      <div class="chat-message-text">
        <MessageText
          text={entry.text}
          selfName={selfName}
          mentionMembers={mentionMembers}
          onOpenProfile={actions.openProfile}
          onOpenLink={actions.openLink}
        />
        {entry.editedAt && <span class="chat-edited"> (edited)</span>}
      </div>
      {reactions.length > 0 && (
        <div class="chat-reactions">
          {reactions.map(([emoji, authors]) => (
            <button
              type="button"
              key={emoji}
              class={`chat-reaction${authors.includes(author) ? " mine" : ""}`}
              aria-label={`${emoji} ${authors.length}`}
              onClick={() => actions.react(entry, emoji)}
            >
              <span>{emoji}</span>
              <span class="chat-reaction-count">{authors.length}</span>
            </button>
          ))}
        </div>
      )}
      {!entry.pending && (
        <div class="chat-toolbar">
          {picking ? (
            CHAT_REACTIONS.map((emoji) => (
              <button
                type="button"
                key={emoji}
                class="chat-tool chat-tool-emoji"
                data-tooltip={`react ${emoji}`}
                aria-label={`react ${emoji}`}
                onClick={() => {
                  setPicking(false);
                  actions.react(entry, emoji);
                }}
              >
                {emoji}
              </button>
            ))
          ) : (
            <>
              <button type="button" class="chat-tool" data-tooltip="react" aria-label="react" onClick={() => setPicking(true)}>
                <IconFaceSmilePlus size={16} />
              </button>
              {canPost && (
                <button type="button" class="chat-tool" data-tooltip="reply" aria-label="reply" onClick={() => actions.reply(entry)}>
                  <IconArrowCornerUpLeft size={16} />
                </button>
              )}
              {mine && canPost && (
                <button type="button" class="chat-tool" data-tooltip="edit" aria-label="edit" onClick={() => actions.edit(entry)}>
                  <IconPencil size={16} />
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  class={`chat-tool${confirmDelete ? " danger" : ""}`}
                  data-tooltip={confirmDelete ? "click again to delete" : "delete"}
                  aria-label={confirmDelete ? "confirm delete" : "delete"}
                  onClick={() => {
                    if (confirmDelete) actions.remove(entry);
                    else setConfirmDelete(true);
                  }}
                >
                  <IconCrossMedium size={16} />
                </button>
              )}
              {!mine && (
                <button
                  type="button"
                  class="chat-tool"
                  data-tooltip="block"
                  aria-label="block"
                  onClick={() => actions.block({ author: entry.author, name: entry.name, role: entry.role })}
                >
                  <IconGhost size={16} />
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ChatMessage);
