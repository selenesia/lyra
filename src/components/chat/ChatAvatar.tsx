import { displayName, type ChatMember } from "../../features/chat/chatProtocol.ts";
import { chatMediaUrl } from "../../features/chat/chatMedia.ts";
import { cosmeticUrl, useCosmetics } from "../../features/chat/chatCosmetics.ts";
import { useCosmeticMotion } from "../../features/chat/cosmeticMotion.ts";

interface ChatAvatarProps {
  member: Pick<ChatMember, "author" | "name" | "display" | "avatar">;
  size: number;
  src?: string | null | undefined;
  class?: string;
  decoration?: string | undefined;
  animate?: boolean;
}

function hideBrokenImage(event: Event) {
  (event.currentTarget as HTMLImageElement).hidden = true;
}

export function avatarHue(author: string): number {
  return Math.round((Number(author) || 0) * 137.508) % 360;
}

function AvatarDecoration({ id, animate }: { id: string; animate: boolean }) {
  const item = useCosmetics()?.find("decoration", id);
  const { ref, moving } = useCosmeticMotion<HTMLImageElement>(!!item && animate);
  if (!item) return null;
  return (
    <img
      ref={ref}
      class="chat-avatar-decoration"
      src={cosmeticUrl(moving ? item.animated : item.still)}
      alt=""
      decoding="async"
      loading="lazy"
      draggable={false}
      onError={(event) => {
        const image = event.currentTarget;
        if (moving && image.getAttribute("src") !== cosmeticUrl(item.still)) image.src = cosmeticUrl(item.still);
        else image.hidden = true;
      }}
      onLoad={(event) => { event.currentTarget.hidden = false; }}
    />
  );
}

export default function ChatAvatar({ member, size, src, class: extra, decoration, animate = false }: ChatAvatarProps) {
  const image = src === undefined ? member.avatar && chatMediaUrl("avatar", member.author, member.avatar) : src;
  const hue = avatarHue(member.author);
  const avatar = (
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
  if (!decoration) return avatar;
  return (
    <span class="chat-avatar-decorated" aria-hidden="true">
      {avatar}
      <AvatarDecoration id={decoration} animate={animate} />
    </span>
  );
}
