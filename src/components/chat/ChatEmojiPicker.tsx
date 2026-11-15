import { memo } from "preact/compat";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useManagedModal } from "../../core/ui/modal.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { CHAT_REACTIONS, isChatReaction } from "../../features/chat/chatProtocol.ts";
import type { JSX } from "preact";
import {
  IconAirplane,
  IconBasketball,
  IconBurger,
  IconClock,
  IconCrossMedium,
  IconFaceSmile,
  IconFlag,
  IconHand,
  IconHeart,
  IconLightBulb,
  IconTree,
} from "../icons";

interface EmojiEntry {
  emoji: string;
  name: string;
}

interface EmojiSection {
  id: string;
  label: string;
  entries: EmojiEntry[];
}

const RECENT_STORAGE = "lyra-chat-emoji-recent";
const RECENT_LIMIT = 24;
const GROUP_ICONS: Record<string, (props: { size?: number }) => JSX.Element> = {
  recent: IconClock,
  smileys: IconFaceSmile,
  people: IconHand,
  nature: IconTree,
  food: IconBurger,
  travel: IconAirplane,
  activities: IconBasketball,
  objects: IconLightBulb,
  symbols: IconHeart,
  flags: IconFlag,
};

let emojiGroups: Promise<EmojiSection[]> | undefined;

function loadEmojiGroups(): Promise<EmojiSection[]> {
  emojiGroups ??= import("../../features/chat/chatEmojiData.ts").then(
    ({ CHAT_EMOJI_GROUPS }) =>
      CHAT_EMOJI_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        entries: group.emoji.split("\n").map((line) => {
          const space = line.indexOf(" ");
          return { emoji: line.slice(0, space), name: line.slice(space + 1) };
        }),
      })),
    (error: unknown) => {
      emojiGroups = undefined;
      throw error;
    },
  );
  return emojiGroups;
}

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isChatReaction).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(emoji: string): void {
  try {
    const next = [emoji, ...readRecent().filter((entry) => entry !== emoji)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_STORAGE, JSON.stringify(next));
  } catch {
    return;
  }
}

function adjacentEmoji(buttons: HTMLButtonElement[], from: HTMLButtonElement, key: string): HTMLButtonElement | undefined {
  const index = buttons.indexOf(from);
  if (key === "ArrowLeft") return buttons[index - 1];
  if (key === "ArrowRight") return buttons[index + 1];
  const origin = from.getBoundingClientRect();
  const step = key === "ArrowDown" ? 1 : -1;
  let rowTop: number | undefined;
  let best: HTMLButtonElement | undefined;
  let bestDistance = Infinity;
  for (let next = index + step; next >= 0 && next < buttons.length; next += step) {
    const rect = buttons[next]!.getBoundingClientRect();
    if (Math.abs(rect.top - origin.top) < 2) continue;
    if (rowTop === undefined) rowTop = rect.top;
    else if (Math.abs(rect.top - rowTop) >= 2) break;
    const distance = Math.abs(rect.left - origin.left);
    if (distance < bestDistance) {
      best = buttons[next];
      bestDistance = distance;
    }
  }
  return best;
}

const EmojiSections = memo(function EmojiSections({ sections }: { sections: EmojiSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.id} class="chat-emoji-section" data-group={section.id} aria-label={section.label}>
          <p class="chat-panel-title">{section.label}</p>
          <div class="chat-emoji-grid">
            {section.entries.map((entry) => (
              <button key={entry.emoji} type="button" class="chat-tool chat-tool-emoji" data-emoji={entry.emoji} aria-label={entry.name}>
                {entry.emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  );
});

interface ChatEmojiPickerProps {
  title: string;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export default function ChatEmojiPicker({ title, onPick, onClose }: ChatEmojiPickerProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [groups, setGroups] = useState<EmojiSection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("recent");
  const [preview, setPreview] = useState<EmojiEntry | null>(null);
  const [recent] = useState(readRecent);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const closingRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
  }, []);

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: true,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: onClose,
  });

  useEffect(() => {
    let live = true;
    loadEmojiGroups().then(
      (loaded) => live && setGroups(loaded),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      cancelAnimationFrame(frameRef.current);
    };
  }, []);

  useEffect(() => {
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) searchRef.current?.focus();
    else dialogRef.current?.focus();
  }, []);

  const names = useMemo(() => new Map(groups?.flatMap((group) => group.entries.map((entry) => [entry.emoji, entry.name] as const))), [groups]);

  const browseSections = useMemo<EmojiSection[]>(() => {
    if (!groups) return [];
    const picks = recent.length ? recent : CHAT_REACTIONS;
    const top = {
      id: "recent",
      label: recent.length ? "recent" : "popular",
      entries: picks.flatMap((emoji) => {
        const name = names.get(emoji);
        return name ? [{ emoji, name }] : [];
      }),
    };
    return [top, ...groups];
  }, [groups, names, recent]);

  const search = query.trim().toLowerCase();
  const results = useMemo<EmojiSection[] | null>(() => {
    if (!search || !groups) return null;
    const words = search.split(/\s+/);
    const seen = new Set<string>();
    const ranked: { entry: EmojiEntry; rank: number }[] = [];
    for (const group of groups) {
      for (const entry of group.entries) {
        if (seen.has(entry.emoji) || !words.every((word) => entry.name.includes(word) || entry.emoji === word)) continue;
        seen.add(entry.emoji);
        const rank = entry.name === search || entry.emoji === search ? 0 : entry.name.startsWith(search) ? 1 : ` ${entry.name}`.includes(` ${words[0]}`) ? 2 : 3;
        ranked.push({ entry, rank });
      }
    }
    ranked.sort((a, b) => a.rank - b.rank);
    return ranked.length ? [{ id: "results", label: "results", entries: ranked.map(({ entry }) => entry) }] : [];
  }, [groups, search]);

  const sections = results ?? browseSections;

  const pick = useCallback(
    (emoji: string, keepOpen: boolean) => {
      rememberEmoji(emoji);
      onPick(emoji);
      if (!keepOpen) requestClose();
    },
    [onPick, requestClose],
  );

  const syncActiveGroup = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      if (!scroll || results) return;
      let current = "recent";
      for (const section of scroll.querySelectorAll<HTMLElement>(".chat-emoji-section")) {
        if (section.offsetTop > scroll.scrollTop + 8) break;
        current = section.dataset.group ?? current;
      }
      setActiveGroup(current);
    });
  }, [results]);

  const jumpTo = useCallback((id: string) => {
    setQuery("");
    setActiveGroup(id);
    requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      const section = scroll?.querySelector<HTMLElement>(`.chat-emoji-section[data-group="${id}"]`);
      if (scroll && section) scroll.scrollTop = section.offsetTop;
    });
  }, []);

  const showPreview = useCallback((event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-emoji]");
    if (!button) return;
    const emoji = button.dataset.emoji!;
    setPreview((current) => (current?.emoji === emoji ? current : { emoji, name: button.getAttribute("aria-label") ?? "" }));
  }, []);

  const onGridKeyDown = useCallback((event: KeyboardEvent) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const from = (event.target as Element).closest<HTMLButtonElement>("[data-emoji]");
    const scroll = scrollRef.current;
    if (!from || !scroll) return;
    event.preventDefault();
    const buttons = Array.from(scroll.querySelectorAll<HTMLButtonElement>("[data-emoji]"));
    const next = adjacentEmoji(buttons, from, event.key);
    if (next) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp" || (event.key === "ArrowLeft" && buttons[0] === from)) {
      searchRef.current?.focus();
    }
  }, []);

  return (
    <div
      ref={dialogRef}
      class={`popup chat-emoji-picker ${modalStateClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-emoji-title"
      tabIndex={-1}
      onAnimationEnd={onAnimationEnd}
    >
      <h2 id="chat-emoji-title">{title}</h2>
      <div class="input-container">
        <input
          ref={searchRef}
          type="text"
          placeholder="search emojis... ◝(ᵔᗜᵔ)◜"
          aria-label="search emoji... ◝(ᵔᗜᵔ)◜"
          autoComplete="off"
          spellcheck={false}
          value={query}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const first = results?.[0]?.entries[0];
              if (first) pick(first.emoji, event.shiftKey);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              scrollRef.current?.querySelector<HTMLButtonElement>("[data-emoji]")?.focus();
            }
          }}
        />
      </div>
      <div class="chat-emoji-tabs">
        {browseSections.map((section) => {
          const Icon = GROUP_ICONS[section.id]!;
          return (
            <button
              key={section.id}
              type="button"
              class="chat-tool"
              aria-label={section.label}
              aria-pressed={!results && activeGroup === section.id}
              data-tooltip={section.label}
              onClick={() => jumpTo(section.id)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>
      <div
        ref={scrollRef}
        class="chat-emoji-scroll"
        onScroll={syncActiveGroup}
        onPointerOver={showPreview}
        onFocusIn={showPreview}
        onKeyDown={onGridKeyDown}
        onClick={(event) => {
          const button = (event.target as Element).closest<HTMLButtonElement>("[data-emoji]");
          if (button) pick(button.dataset.emoji!, event.shiftKey);
        }}
      >
        {failed ? (
          <p class="chat-profile-meta chat-emoji-empty">{negativeMessage("emoji could not load")}</p>
        ) : !groups ? (
          <p class="chat-profile-meta chat-emoji-empty">loading emoji</p>
        ) : sections.length ? (
          <EmojiSections sections={sections} />
        ) : (
          <p class="chat-profile-meta chat-emoji-empty">no emoji match that search</p>
        )}
      </div>
      <div class="chat-emoji-preview" aria-hidden="true">
        {preview ? (
          <>
            <span class="chat-emoji-preview-glyph">{preview.emoji}</span>
            <span class="chat-emoji-preview-name">{preview.name}</span>
          </>
        ) : (
          <span class="chat-emoji-preview-name">shift-click to pick more than one</span>
        )}
      </div>
      <button type="button" class="modal-close-btn" aria-label="close" onClick={requestClose}>
        <IconCrossMedium />
      </button>
    </div>
  );
}
