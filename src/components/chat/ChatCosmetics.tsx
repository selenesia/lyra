import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useCosmeticMotion } from "../../features/chat/cosmeticMotion.ts";
import { prefersReducedMotion } from "../../core/config/advancedSettings.ts";
import { useVirtualGrid } from "../../hooks/useVirtualGrid.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import type { ChatCosmeticSlot, ChatMember } from "../../features/chat/chatProtocol.ts";
import {
  NAMEPLATE_PALETTES,
  cosmeticBlob,
  cosmeticMatches,
  cosmeticUrl,
  loadCosmetics,
  useCosmetics,
  type CosmeticEffectLayer,
  type CosmeticItem,
} from "../../features/chat/chatCosmetics.ts";
import { IconCheckCircle2 } from "../icons";
import ChatAvatar from "./ChatAvatar.tsx";

const EFFECT_STILL: CosmeticEffectLayer = { src: "", loop: false, start: 0, duration: 0, delay: 0, x: 0, y: 0, z: 100, width: 450, height: 880 };

function layerStyle(layer: CosmeticEffectLayer): string {
  return `--x:${layer.x};--y:${layer.y};--w:${layer.width};--h:${layer.height};z-index:${layer.z}`;
}

export function MemberNameplate({ id, active }: { id: string; active: boolean }) {
  const item = useCosmetics()?.find("nameplate", id);
  const { ref, moving } = useCosmeticMotion<HTMLSpanElement>(!!item && active);
  if (!item) return null;
  const color = item.palette ? NAMEPLATE_PALETTES[item.palette] : undefined;
  return (
    <span ref={ref} class="chat-nameplate" aria-hidden="true" style={color ? `--nameplate-color:${color}` : undefined}>
      <img src={cosmeticUrl(item.still)} alt="" decoding="async" loading="lazy" draggable={false} />
      {moving && <NameplateVideo key={item.video} src={cosmeticUrl(item.video)} />}
    </span>
  );
}

function NameplateVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current!;
    video.muted = true;
    void video.play().catch(() => {});
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);
  return <video ref={ref} src={src} autoplay muted loop playsInline disablePictureInPicture
    onPlaying={(event) => { event.currentTarget.hidden = false; event.currentTarget.dataset.playing = "true"; }}
    onError={(event) => { event.currentTarget.hidden = true; delete event.currentTarget.dataset.playing; }} />;
}

function EffectLayer({ layer }: { layer: CosmeticEffectLayer }) {
  const [src, setSrc] = useState<string | null>(null);
  const loadedRef = useRef<((url: string) => void) | null>(null);

  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const sources = layer.random?.length ? layer.random : [layer.src];
    const pick = () => sources[Math.floor(Math.random() * sources.length)]!;
    let name = pick();
    const show = (next: string | null) => {
      if (current) URL.revokeObjectURL(current);
      current = next;
      setSrc(next);
    };
    const scheduleEnd = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        if (!layer.loop || layer.delay > 0) show(null);
        if (layer.loop) {
          timer = setTimeout(() => {
            name = pick();
            void play();
          }, layer.delay);
        }
      }, Math.max(layer.duration, 100));
    };
    const play = async () => {
      const blob = await cosmeticBlob(name, controller.signal);
      if (!alive) return;
      if (blob) {
        const url = URL.createObjectURL(blob);
        loadedRef.current = (loaded) => {
          if (loaded !== current) return;
          loadedRef.current = null;
          scheduleEnd();
        };
        show(url);
      } else scheduleEnd();
    };
    void cosmeticBlob(name, controller.signal);
    timer = setTimeout(() => void play(), layer.start);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
      loadedRef.current = null;
      if (current) URL.revokeObjectURL(current);
    };
  }, [layer]);

  if (!src) return null;
  return <img class="chat-effect-layer" src={src} alt="" draggable={false} style={layerStyle(layer)}
    onError={(event) => { event.currentTarget.hidden = true; loadedRef.current?.(event.currentTarget.src); }}
    onLoad={(event) => { event.currentTarget.hidden = false; loadedRef.current?.(event.currentTarget.src); }} />;
}

export function ProfileEffect({ id }: { id?: string | undefined }) {
  const effect = useCosmetics(!!id)?.find("effect", id);
  const { ref, moving } = useCosmeticMotion<HTMLDivElement>(!!effect);
  if (!effect) return null;
  return (
    <div ref={ref} class="chat-profile-effect" aria-hidden="true">
      {!moving
        ? effect.still && (document.hidden || prefersReducedMotion()) && (
            <img class="chat-effect-layer" src={cosmeticUrl(effect.still)} alt="" draggable={false} style={layerStyle(EFFECT_STILL)} />
          )
        : effect.layers.map((layer, index) => <EffectLayer key={`${effect.id}:${index}`} layer={layer} />)}
    </div>
  );
}

export function ProfileFrame({ id, front }: { id?: string | undefined; front: boolean }) {
  const frame = useCosmetics(!!id)?.find("frame", id);
  const layers = frame?.layers.filter((layer) => layer.front === front) ?? [];
  if (!frame || !layers.length) return null;
  return (
    <div
      class={`chat-profile-frame${front ? " is-front" : ""}`}
      aria-hidden="true"
      style={`--frame-inner:${frame.inner};--frame-top:${frame.top};--frame-bottom:${frame.bottom};--frame-side:${frame.side}`}
    >
      {layers.map((layer) => (
        <img
          key={layer.src}
          class={`chat-frame-layer is-${layer.anchor}${layer.kind !== "staple" || layer.responsive ? " is-stretched" : ""}`}
          src={cosmeticUrl(layer.src)}
          alt=""
          decoding="async"
          draggable={false}
        />
      ))}
    </div>
  );
}

function CosmeticPreview({ slot, item, member, moving }: { slot: ChatCosmeticSlot; item: CosmeticItem; member: ChatMember; moving: boolean }) {
  if (slot === "decoration") {
    return (
      <span class="chat-cosmetic-media chat-cosmetic-avatar">
        <ChatAvatar member={member} size={48} decoration={item.id} animate={moving} />
      </span>
    );
  }
  if (slot === "frame" && "inner" in item) {
    const width = 100 / (1 + item.side * 2 / item.inner);
    const height = 100 / (4 / 3 + (item.top + item.bottom) / item.inner) * 5 / 4;
    const scale = Math.min(width, height) * 0.9;
    return (
      <span class="chat-cosmetic-media chat-cosmetic-frame">
        <span class="chat-cosmetic-card" style={`width:${scale}%;transform:translateY(${(item.top - item.bottom) / item.inner * 37.5}%)`}>
          <ProfileFrame id={item.id} front={false} />
          <span class="chat-cosmetic-card-body" />
          <ProfileFrame id={item.id} front />
        </span>
      </span>
    );
  }
  if (slot === "nameplate" && "video" in item) {
    return (
      <span class="chat-cosmetic-media chat-cosmetic-plate">
        <MemberNameplate id={item.id} active={moving} />
      </span>
    );
  }
  const picture = "preview" in item ? (item.preview ?? item.still) : undefined;
  return picture ? (
    <img class="chat-cosmetic-media" src={cosmeticUrl(picture)} alt="" loading="lazy" decoding="async" draggable={false} />
  ) : (
    <span class="chat-cosmetic-media" />
  );
}

interface CosmeticPickerProps {
  slot: ChatCosmeticSlot;
  label: string;
  value: string | undefined;
  member: ChatMember;
  disabled: boolean;
  onPick: (id: string) => void;
}

export function CosmeticPicker({ slot, label, value, member, disabled, onPick }: CosmeticPickerProps) {
  const cosmetics = useCosmetics();
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [hovered, setHovered] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const id = `chat-cosmetic-${slot}`;
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    let live = true;
    void loadCosmetics().then((loaded) => {
      if (live && !loaded) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const matches = useMemo(
    () => (cosmetics ? cosmetics.lists[slot].filter((item) => cosmeticMatches(item, needle, cosmetics.categories)) : []),
    [cosmetics, slot, needle],
  );
  const { gridRef, range, visibleItems: shown, scrollToIndex } = useVirtualGrid(matches, matches.length > 0, scrollRef);
  const total = cosmetics?.lists[slot].length;
  const searchLabel = total === undefined
    ? `search ${label}s`
    : `search through ${total} ${label}${total === 1 ? "" : "s"}`;
  const optionId = (item: CosmeticItem) => `${id}-${item.id}`;

  useEffect(() => {
    if (active >= 0) scrollToIndex(active);
  }, [active]);

  const columns = () => {
    const grid = gridRef.current;
    return grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length) : 1;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disabled || !matches.length) return;
    const last = matches.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(active < 0 ? 0 : Math.min(last, active + columns()));
    } else if (event.key === "ArrowUp" && active >= 0) {
      event.preventDefault();
      setActive(Math.max(0, active - columns()));
    } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && active >= 0) {
      event.preventDefault();
      setActive(Math.min(last, Math.max(0, active + (event.key === "ArrowRight" ? 1 : -1))));
    } else if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      onPick(matches[active]!.id);
    }
  };

  const status = failed
    ? negativeMessage("cosmetics are unavailable right now")
    : !cosmetics
      ? "loading..."
      : !matches.length
        ? negativeMessage("nothing matches that search")
        : null;

  return (
    <div class="chat-cosmetic-picker">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-label={searchLabel}
        aria-expanded={shown.length > 0}
        aria-controls={`${id}-options`}
        aria-autocomplete="list"
        aria-activedescendant={active >= range.start && active < range.end && matches[active] ? optionId(matches[active]!) : undefined}
        value={query}
        maxLength={64}
        placeholder={`${searchLabel}... ◝(ᵔᗜᵔ)◜`}
        autocomplete="off"
        disabled={disabled}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActive(-1);
          setHovered(null);
          if (gridRef.current) gridRef.current.scrollTop = 0;
        }}
        onKeyDown={onKeyDown}
      />
      {status ? (
        <p id={`${id}-options`} class="chat-profile-meta chat-picker-empty" aria-live="polite">
          {status}
        </p>
      ) : (
        <div
          ref={(node) => { gridRef.current = node; scrollRef.current = node; }}
          id={`${id}-options`}
          class={`chat-gif-grid chat-cosmetic-grid is-${slot}`}
          role="listbox"
          aria-label={label}
          onScroll={() => setHovered(null)}
        >
          {range.topSpacer > 0 && <div class="chat-cosmetic-virtual-spacer" aria-hidden="true" style={`height:${range.topSpacer}px`} />}
          {shown.map((item, offset) => {
            const index = range.start + offset;
            const chosen = item.id === value;
            return (
              <div
                id={optionId(item)}
                key={item.id}
                role="option"
                aria-selected={chosen}
                aria-label={item.name}
                aria-posinset={index + 1}
                aria-setsize={matches.length}
                aria-disabled={disabled}
                data-tooltip={item.name}
                class={`chat-suggestion chat-gif chat-cosmetic${index === active ? " active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHovered(item.id)}
                onMouseLeave={() => setHovered((current) => (current === item.id ? null : current))}
                onClick={() => {
                  setActive(index);
                  if (!disabled) onPick(item.id);
                }}
              >
                <span class="chat-gif-frame">
                  <CosmeticPreview slot={slot} item={item} member={member} moving={hovered === item.id || index === active} />
                  {chosen && (
                    <span class="chat-cosmetic-selected">
                      <IconCheckCircle2 size={22} solid />
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {range.bottomSpacer > 0 && <div class="chat-cosmetic-virtual-spacer" aria-hidden="true" style={`height:${range.bottomSpacer}px`} />}
        </div>
      )}
    </div>
  );
}
