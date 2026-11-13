import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ChatChannel, ChatMember } from "../../features/chat/chatProtocol.ts";
import { MESSAGE_TOKEN } from "../../features/chat/chatText.ts";

interface MessageTextProps {
  text: string;
  selfName: string;
  mentionMembers: ReadonlyMap<string, ChatMember>;
  channels: ReadonlySet<string>;
  onOpenProfile: (member: ChatMember) => void;
  onOpenLink: (url: string) => void;
  onOpenChannel: (channel: ChatChannel) => void;
}

function Spoiler({ children }: { children: ComponentChildren }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      class={`chat-spoiler${revealed ? " revealed" : ""}`}
      role="button"
      tabIndex={revealed ? -1 : 0}
      aria-label={revealed ? undefined : "spoiler"}
      onClick={(event) => {
        event.stopPropagation();
        setRevealed(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") setRevealed(true);
      }}
    >
      {children}
    </span>
  );
}

function render(text: string, props: MessageTextProps, depth: number, inSpoiler = false): ComponentChildren[] {
  const nodes: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(MESSAGE_TOKEN)) {
    const [token, code, spoiler, bold, strike, star, underscore, link, mention, channelTag] = match;
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    last = index + token.length;
    const inner = (start: number, end: number) =>
      depth < 3 ? render(token.slice(start, token.length - end), props, depth + 1, inSpoiler || !!spoiler) : token.slice(start, token.length - end);
    if (code) nodes.push(<code class="chat-code">{token.slice(1, -1)}</code>);
    else if (spoiler) nodes.push(<Spoiler>{inner(2, 2)}</Spoiler>);
    else if (bold) nodes.push(<strong>{inner(2, 2)}</strong>);
    else if (strike) nodes.push(<s>{inner(2, 2)}</s>);
    else if (star || underscore) nodes.push(<em>{inner(1, 1)}</em>);
    else if (link) {
      nodes.push(
        <a
          class="chat-link"
          href={token}
          rel="noreferrer noopener"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onOpenLink(token);
          }}
        >
          {token}
        </a>,
      );
    } else if (mention) {
      const self = !!props.selfName && token.slice(1).toLowerCase() === props.selfName.toLowerCase();
      const member = props.mentionMembers.get(token.slice(1).toLowerCase());
      const classes = `chat-mention${self ? " self" : ""}`;
      nodes.push(member && !inSpoiler ? (
        <button
          type="button"
          class={classes}
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenProfile(member);
          }}
        >
          {token}
        </button>
      ) : <span class={classes}>{token}</span>);
    } else if (channelTag) {
      const channel = token.slice(1).toLowerCase();
      if (!props.channels.has(channel)) nodes.push(token);
      else if (inSpoiler) nodes.push(<span class="chat-mention">#{channel}</span>);
      else {
        nodes.push(
          <button
            type="button"
            class="chat-mention"
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenChannel(channel as ChatChannel);
            }}
          >
            #{channel}
          </button>,
        );
      }
    }
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function MessageText(props: MessageTextProps) {
  return <>{render(props.text, props, 0)}</>;
}
