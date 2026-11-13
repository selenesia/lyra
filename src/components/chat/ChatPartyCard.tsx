import { useEffect, useState } from "preact/hooks";
import { useImageLoad } from "../../hooks/useImageLoad.ts";
import { CHAT_REACTION_FACES, type ChatParty, type ChatPartyInvite } from "../../features/chat/chatProtocol.ts";
import { partyKindLabel } from "../../features/chat/chatParty.ts";
import IconBase from "../icons/IconBase.tsx";
import { ICON_PATHS } from "../icons/paths.ts";
import ChatAvatar from "./ChatAvatar.tsx";

const CONFIRM_MS = 3_000;

interface ChatPartyCardProps {
  invite: ChatPartyInvite;
  party: ChatParty | undefined;
  hostName: string;
  viewerAuthor: string;
  onJoin: (invite: ChatPartyInvite) => void;
  onEnd: (id: string) => void;
}

export default function ChatPartyCard({ invite, party, hostName, viewerAuthor, onJoin, onEnd }: ChatPartyCardProps) {
  const image = useImageLoad(invite.poster ?? null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const live = !!party && !party.ended;

  useEffect(() => {
    if (!confirmEnd) return;
    const timer = setTimeout(() => setConfirmEnd(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmEnd]);

  const label = (live ? party.label : invite.label)?.toLowerCase();
  const detail = ["watch party", partyKindLabel(invite.kind), label, `hosted by ${party?.hostName ?? hostName}`].filter(Boolean).join(" · ");
  const watchers = live ? party.watchers : [];
  const watching = watchers.some((member) => member.author === viewerAuthor);

  return (
    <div class={`chat-party${live ? "" : " is-ended"}`} role="group" aria-label={`watch party for ${invite.title}`}>
      <span class={`chat-party-poster${image.loaded ? " loaded" : ""}`}>
        {image.errored ? (
          <IconBase icon={ICON_PATHS.IconImageAltText} />
        ) : (
          <img
            ref={image.imgRef}
            src={image.src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={image.onLoad}
            onError={image.onError}
          />
        )}
      </span>
      <span class="chat-party-info">
        <span class="chat-party-title">{invite.title}</span>
        <span class="chat-party-detail">{detail}</span>
        {live ? (
          <span class="chat-party-watchers">
            <span class="chat-reaction-faces">
              {watchers.slice(0, CHAT_REACTION_FACES).map((member) => (
                <ChatAvatar key={member.author} member={member} size={18} />
              ))}
            </span>
            <span class="chat-party-detail">{watchers.length} watching</span>
          </span>
        ) : (
          <span class="chat-party-detail">this watch party has ended</span>
        )}
      </span>
      {live && (
        <span class="chat-party-actions">
          <button
            type="button"
            class={`settings-page-button${watching ? "" : " is-primary"}`}
            onClick={() => onJoin(invite)}
          >
            {watching ? "watching" : "join"}
          </button>
          {party.host === viewerAuthor && (
            <button
              type="button"
              class={`settings-page-button${confirmEnd ? " chat-danger-btn" : ""}`}
              aria-label={confirmEnd ? "confirm end party" : "end party"}
              onClick={() => {
                if (!confirmEnd) {
                  setConfirmEnd(true);
                  return;
                }
                setConfirmEnd(false);
                onEnd(invite.id);
              }}
            >
              {confirmEnd ? "click again to end" : "end party"}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
