import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useManagedModal } from "../../core/ui/modal.ts";
import {
  chatNameSwatch,
  hexToRgb,
  hsvToRgb,
  isCustomNameColor,
  readableNameColor,
  rgbToHex,
  rgbToHsv,
  type ChatNameStyle,
} from "../../features/chat/chatNameStyle.ts";
import type { ChatMember } from "../../features/chat/chatProtocol.ts";
import ChatDisplayName from "./ChatDisplayName.tsx";
import { IconCrossMedium } from "../icons";
import "../../assets/styles/chat/chat-color.css";

const RECENT_STORAGE = "lyra-chat-name-colors";
const RECENT_LIMIT = 12;
const HEX_INPUT = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isCustomNameColor).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberColor(color: string): void {
  try {
    const next = [color, ...readRecent().filter((entry) => entry !== color)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_STORAGE, JSON.stringify(next));
  } catch {
    return;
  }
}

function parseHex(text: string): string | null {
  const match = HEX_INPUT.exec(text.trim());
  if (!match) return null;
  const digits = match[1]!.toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}

type Hsv = [number, number, number];

const clamp = (value: number) => Math.min(1, Math.max(0, value));

interface ChatColorPickerProps {
  title?: string;
  value: string | undefined;
  member?: Pick<ChatMember, "name" | "display"> & ChatNameStyle;
  adjust?: ((color: string) => string) | undefined;
  onPreview?: (color: string) => void;
  onPick: (color: string) => void;
  onClose: () => void;
}

export default function ChatColorPicker({ title = "custom color", value, member, adjust, onPreview, onPick, onClose }: ChatColorPickerProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(value && isCustomNameColor(value) ? value : "#d3b4ff")));
  const [hexText, setHexText] = useState(() => rgbToHex(hsvToRgb(...hsv)));
  const [recent] = useState(readRecent);
  const dialogRef = useRef<HTMLDivElement>(null);
  const hexRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
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
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) hexRef.current?.focus();
    else dialogRef.current?.focus();
  }, []);

  const hex = rgbToHex(hsvToRgb(...hsv));
  const shown = member ? readableNameColor(hex) : adjust ? adjust(hex) : hex;
  const previewRef = useRef({ initial: shown, onPreview });
  previewRef.current.onPreview = onPreview;

  useEffect(() => {
    const preview = previewRef.current;
    if (shown === preview.initial) return;
    preview.initial = "";
    preview.onPreview?.(shown);
  }, [shown]);

  const update = useCallback((next: Hsv) => {
    setHsv(next);
    setHexText(rgbToHex(hsvToRgb(...next)));
  }, []);

  const pickHex = useCallback(
    (color: string) => {
      const [hue, saturation, brightness] = rgbToHsv(hexToRgb(color));
      update([saturation ? hue : hsv[0], saturation, brightness]);
    },
    [hsv, update],
  );

  const apply = useCallback(() => {
    rememberColor(shown);
    onPick(shown);
    requestClose();
  }, [onPick, requestClose, shown]);

  const moveArea = useCallback(
    (event: PointerEvent) => {
      const rect = areaRef.current?.getBoundingClientRect();
      if (!rect) return;
      update([hsv[0], clamp((event.clientX - rect.left) / rect.width), 1 - clamp((event.clientY - rect.top) / rect.height)]);
    },
    [hsv, update],
  );

  return (
    <div
      ref={dialogRef}
      class={`popup chat-color-picker ${modalStateClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-color-title"
      tabIndex={-1}
      onAnimationEnd={onAnimationEnd}
    >
      <h2 id="chat-color-title">{title}</h2>
      <div
        ref={areaRef}
        class="chat-color-area"
        role="slider"
        tabIndex={0}
        aria-label="saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv[1] * 100)}
        aria-valuetext={`saturation ${Math.round(hsv[1] * 100)}%, brightness ${Math.round(hsv[2] * 100)}%`}
        style={{ "--picker-hue": hsv[0], "--picker-x": hsv[1], "--picker-y": 1 - hsv[2], "--picker-color": hex }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          moveArea(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) moveArea(event);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.02;
          const moves: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, step],
            ArrowDown: [0, -step],
          };
          const move = moves[event.key];
          if (!move) return;
          event.preventDefault();
          update([hsv[0], clamp(hsv[1] + move[0]), clamp(hsv[2] + move[1])]);
        }}
      >
        <span class="chat-color-thumb" />
      </div>
      <input
        type="range"
        class="chat-color-hue"
        min={0}
        max={359}
        step={1}
        aria-label="hue"
        value={Math.round(hsv[0])}
        style={{ "--picker-hue": hsv[0] }}
        onInput={(event) => update([Number(event.currentTarget.value), hsv[1], hsv[2]])}
      />
      <div class="input-container chat-color-hex">
        <span class="chat-color-dot" style={{ background: shown }} aria-hidden="true" />
        <input
          ref={hexRef}
          type="text"
          aria-label="hex color"
          autoComplete="off"
          spellcheck={false}
          maxLength={7}
          value={hexText}
          onInput={(event) => {
            const text = event.currentTarget.value;
            setHexText(text);
            const parsed = parseHex(text);
            if (parsed) {
              const [hue, saturation, brightness] = rgbToHsv(hexToRgb(parsed));
              setHsv([saturation ? hue : hsv[0], saturation, brightness]);
            }
          }}
          onBlur={() => setHexText(hex)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            apply();
          }}
        />
      </div>
      {recent.length > 0 && (
        <>
          <p class="chat-panel-title">recent</p>
          <div class="chat-color-swatches">
            {recent.map((color) => (
              <button
                key={color}
                type="button"
                class="chat-tool chat-color-swatch"
                aria-label={color}
                aria-pressed={color === shown}
                data-tooltip={color}
                onClick={() => pickHex(color)}
              >
                <span class="chat-color-dot" style={{ background: chatNameSwatch(color) }} />
              </button>
            ))}
          </div>
        </>
      )}
      {member && (
        <div class="chat-color-preview">
          <span class="chat-color-preview-name">
            <ChatDisplayName member={{ ...member, nameColor: shown }} />
          </span>
          {shown !== hex && <span class="chat-color-preview-note">brightened to stay readable</span>}
        </div>
      )}
      <div class="input-container chat-profile-actions">
        <button type="button" onClick={apply}>
          use color
        </button>
        <button type="button" class="chat-secondary-btn" onClick={requestClose}>
          cancel
        </button>
      </div>
      <button type="button" class="modal-close-btn" aria-label="close" onClick={requestClose}>
        <IconCrossMedium />
      </button>
    </div>
  );
}
