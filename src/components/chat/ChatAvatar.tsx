import { displayName, type ChatMember } from "../../features/chat/chatProtocol.ts";
import { chatMediaUrl } from "../../features/chat/chatMedia.ts";

interface ChatAvatarProps {
  member: Pick<ChatMember, "author" | "name" | "display" | "avatar">;
  size: number;
  src?: string | null | undefined;
  class?: string;
}

function hideBrokenImage(event: Event) {
  (event.currentTarget as HTMLImageElement).hidden = true;
}

export function avatarHue(author: string): number {
  return Math.round((Number(author) || 0) * 137.508) % 360;
}

export default function ChatAvatar({ member, size, src, class: extra }: ChatAvatarProps) {
  const image = src === undefined ? member.avatar && chatMediaUrl("avatar", member.author, member.avatar) : src;
  const hue = avatarHue(member.author);
  return (
    <span
      class={extra ? `chat-avatar ${extra}` : "chat-avatar"}
      style={`--avatar-size:${size}px;--avatar-hue:${hue}`}
      aria-hidden="true"
    >
      {[...displayName(member)][0]}
      {image && (
        <img
          key={image}
          src={image}
          width={size}
          height={size}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={hideBrokenImage}
        />
      )}
    </span>
  );
}
