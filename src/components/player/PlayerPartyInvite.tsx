import { useEffect, useRef, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { CHAT_CHANNELS, canPostIn, type ChatChannel } from "../../features/chat/chatProtocol.ts";
import { isChatRole } from "../../features/chat/chatRoles.ts";
import { IconCheckCircle2 } from "../icons/index.tsx";
import { partyFailureText } from "./watchParty.ts";

export default function PlayerPartyInvite({ open, target, invite, onDone }: {
  open: boolean;
  target: string | undefined;
  invite: (channels: ChatChannel[]) => Promise<boolean>;
  onDone: () => void;
}) {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [selected, setSelected] = useState<ChatChannel[]>([]);
  const [status, setStatus] = useState("loading channels...");
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const inviteWord = selected.length > 1 ? "invites" : "invite";

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setSelected([]);
    setChannels([]);
    setStatus("loading channels...");
    void (async () => {
      try {
        const response = await fetch(appPath("/api/chat/me"), { cache: "no-store", signal: abort.signal });
        const body = await response.json();
        if (abort.signal.aborted) return;
        if (!response.ok || !isChatRole(body.viewer?.role)) {
          setStatus(negativeMessage(partyFailureText(body.code, response.status)));
          return;
        }
        const available = CHAT_CHANNELS.filter((channel) => canPostIn(body.viewer.role, channel)
          && (!target || (target !== "staff-chat" && !target.startsWith("conv:")) || channel === target));
        setChannels(available);
        setStatus(available.length ? "choose channels" : "share this private party using its invite link");
      } catch {
        if (!abort.signal.aborted) setStatus(negativeMessage("chat is unreachable right now"));
      }
    })();
    return () => abort.abort();
  }, [open, target]);

  return (
    <>
      <div class="player-party-heading"><strong>invite to watch together</strong><span role="status">{status}</span></div>
      <div role="group" aria-label="invite channels">
        {channels.map((channel) => (
          <button
            key={channel}
            type="button"
            tabIndex={open ? 0 : -1}
            aria-pressed={selected.includes(channel)}
            class={selected.includes(channel) ? "is-active" : ""}
            disabled={sending}
            onClick={() => setSelected((current) => current.includes(channel) ? current.filter((entry) => entry !== channel) : [...current, channel])}
          >
            <span>#{channel}</span>
            {selected.includes(channel) && <IconCheckCircle2 size={12} solid class="player-option-check" />}
          </button>
        ))}
      </div>
      <div class="player-menu-divider" role="separator" />
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        disabled={sending || !selected.length}
        onClick={async () => {
          if (busy.current || !selected.length) return;
          busy.current = true;
          setSending(true);
          try {
            if (await invite(selected)) onDone();
          } finally {
            busy.current = false;
            setSending(false);
          }
        }}
      >{sending ? `sending ${inviteWord}...` : target ? `send ${inviteWord}` : `start party and send ${inviteWord}`}</button>
    </>
  );
}
