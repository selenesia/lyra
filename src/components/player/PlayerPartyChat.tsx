import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import EditableField from "../EditableField.tsx";
import ChatAvatar from "../chat/ChatAvatar.tsx";
import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  CHAT_LIMITS,
  cleanChatText,
  displayName,
  type ChatPartyMessage,
} from "../../features/chat/chatProtocol.ts";

const GROUP_GAP_MS = 5 * 60_000;
const PINNED_SLACK = 24;

const lastId = (messages: readonly ChatPartyMessage[]) => Number(messages[messages.length - 1]?.id ?? 0);

export function usePartyChatUnread(messages: readonly ChatPartyMessage[], viewer: string, open: boolean): number {
  const latest = lastId(messages);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (open) setSeen(latest);
  }, [open, latest]);
  if (open) return 0;
  return messages.filter((message) => Number(message.id) > seen && message.author !== viewer).length;
}

export default function PlayerPartyChat({ open, messages, watching, say, onClose }: {
  open: boolean;
  messages: readonly ChatPartyMessage[];
  watching: number;
  say: (text: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && open && pinnedRef.current) feed.scrollTop = feed.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open && !sending) fieldRef.current?.focus({ preventScroll: true });
  }, [open, sending]);

  const submit = async () => {
    if (sending || !draft.trim()) return;
    const text = cleanChatText(draft);
    if (!text) {
      setError(negativeMessage(`messages need 1 to ${CHAT_LIMITS.text} characters`));
      return;
    }
    setSending(true);
    setError(null);
    const failure = await say(text);
    setSending(false);
    if (failure) {
      setError(negativeMessage(failure));
      return;
    }
    pinnedRef.current = true;
    setDraft("");
  };

  return (
    <section
      class={`player-party-chat${open ? " is-open" : ""}`}
      role="dialog"
      aria-label="party chat"
      aria-hidden={!open}
      inert={!open}
    >
      <div class="player-party-chat-header">
        <div class="player-party-heading">
          <strong>party chat</strong>
          <span>{watching} watching</span>
        </div>
      </div>
      <div
        ref={feedRef}
        class="player-party-chat-feed"
        role="log"
        aria-label="party messages"
        onScroll={(event) => {
          const feed = event.currentTarget;
          pinnedRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < PINNED_SLACK;
        }}
      >
        {messages.length ? messages.map((message, index) => {
          const previous = messages[index - 1];
          const grouped = previous?.author === message.author && message.at - previous.at < GROUP_GAP_MS;
          return (
            <div key={message.id} class={`player-party-chat-message${grouped ? " is-grouped" : ""}`}>
              {grouped ? <span class="player-party-chat-gap" /> : <ChatAvatar member={message} size={20} />}
              <div class="player-party-chat-body">
                {!grouped && <span class="player-party-name">{displayName(message)}</span>}
                <p class="player-party-chat-text">{message.text}</p>
              </div>
            </div>
          );
        }) : <p class="player-party-chat-empty">no messages yet, say hi!</p>}
      </div>
      <div class="player-party-chat-composer">
        <EditableField
          id="playerPartyChatInput"
          multiline
          fieldRef={fieldRef}
          label="message the party"
          placeholder="message the party"
          value={draft}
          disabled={sending}
          onChange={(value) => {
            setDraft(value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <p class={`player-party-chat-status${error ? " is-error" : ""}`} aria-live="polite">
          {error ?? ""}
        </p>
      </div>
    </section>
  );
}
