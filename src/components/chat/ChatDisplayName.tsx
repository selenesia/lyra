import { useEffect } from "preact/hooks";
import { displayName, type ChatMember } from "../../features/chat/chatProtocol.ts";
import { chatNameFontUrl, chatNameLook, type ChatNameFont, type ChatNameStyle } from "../../features/chat/chatNameStyle.ts";
import { useCosmeticMotion } from "../../features/chat/cosmeticMotion.ts";
import "../../assets/styles/chat/chat-name-style.css";

const fontLinks = new Map<string, HTMLLinkElement>();

export function loadChatNameFont(font: ChatNameFont): void {
  if (font.id === "default" || fontLinks.has(font.id)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chatNameFontUrl(font);
  link.onerror = () => {
    fontLinks.delete(font.id);
    link.remove();
  };
  fontLinks.set(font.id, link);
  document.head.append(link);
}

export default function ChatDisplayName({ member, label }: { member: Pick<ChatMember, "name" | "display"> & ChatNameStyle; label?: string }) {
  const look = chatNameLook(member);
  const { font } = look;
  const { ref, moving } = useCosmeticMotion<HTMLSpanElement>(look.moving);
  useEffect(() => loadChatNameFont(font), [font]);
  return (
    <span
      ref={ref}
      class="chat-display-name"
      data-effect={look.effect}
      data-fill={look.gradient ? "gradient" : undefined}
      data-moving={moving || undefined}
      style={look.vars}
    >
      <span
        class="chat-name-text"
        style={
          font.id === "default"
            ? undefined
            : {
                fontFamily: `"${font.family}", ${font.fallback}`,
                fontWeight: font.weight,
                fontStyle: font.italic ? "italic" : undefined,
                letterSpacing: font.tracking,
                "--name-scale": font.scale,
              }
        }
      >
        {label ?? displayName(member)}
      </span>
    </span>
  );
}
