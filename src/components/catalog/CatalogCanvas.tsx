import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { motionDuration } from "../../core/ui/motion.ts";
import { prefersReducedMotion } from "../../core/config/advancedSettings.ts";
import { getDefaultScrollTarget } from "../../core/ui/dom.ts";
import { canvasHit, canvasLayout, canvasWindow } from "./canvasLayout.ts";

export interface CanvasCard {
  title: string;
  cover?: string | null | undefined;
  smallCover?: string | null | undefined;
  year?: number | undefined;
  rating?: number | undefined;
  adult?: boolean | undefined;
  badge?: string | undefined;
  resumeLabel?: string | undefined;
}

interface Props<T> {
  items: readonly T[];
  getCard: (item: T) => CanvasCard;
  onSelect: (item: T) => void;
  posters: boolean;
  loading: boolean;
  active: boolean;
}

const MAX_COVERS = 1024;
const COVER_BITMAP_BUDGET = 96 * 1024 * 1024;

interface CoverImage {
  source: Blob | null;
  bitmap: ImageBitmap | null;
  pending: boolean;
  failed: boolean;
  loadedAt: number;
  request: AbortController;
}

function releaseCover(entry: CoverImage) {
  entry.request.abort();
  entry.bitmap?.close();
  entry.bitmap = null;
  entry.source = null;
}

async function fetchCover(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, priority: "low" });
  if (!response.ok) throw new Error("cover request failed... /ᐠ - ˕ -マ");
  return response.blob();
}

async function decodeCover(source: Blob, options: ImageBitmapOptions) {
  try {
    return await createImageBitmap(source, options);
  } catch {
    const image = new Image();
    const objectUrl = URL.createObjectURL(source);
    try {
      image.src = objectUrl;
      await image.decode();
      return await createImageBitmap(image, options);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

const MISSING_IMAGE_PATH_DATA =
  "M18.25 3C19.7688 3 21 4.23122 21 5.75V18.25C21 19.7688 19.7688 21 18.25 21H5.75C4.23122 21 3 19.7688 3 18.25V5.75C3 4.23122 4.23122 3 5.75 3H18.25ZM9.2373 13.2373C8.55392 12.5541 7.44608 12.5541 6.7627 13.2373L4.5 15.5V18.25C4.5 18.9404 5.05964 19.5 5.75 19.5H15.5L9.2373 13.2373ZM15 6.5C13.6193 6.5 12.5 7.61929 12.5 9C12.5 10.3807 13.6193 11.5 15 11.5C16.3807 11.5 17.5 10.3807 17.5 9C17.5 7.61929 16.3807 6.5 15 6.5Z";

export default function CatalogCanvas<T>({
  items,
  getCard,
  onSelect,
  posters,
  loading,
  active,
}: Props<T>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef(new Map<string, CoverImage>());
  const redrawRef = useRef(() => {});
  const resetRef = useRef(() => {});
  const dataRef = useRef({ items, getCard, loading });
  dataRef.current = { items, getCard, loading };
  const selectionRef = useRef(onSelect);
  selectionRef.current = onSelect;

  useEffect(
    () => () => {
      for (const entry of imagesRef.current.values()) releaseCover(entry);
      imagesRef.current.clear();
    },
    [],
  );

  useLayoutEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!host || !canvas || !ctx) return;
    const missingImagePath = new Path2D(MISSING_IMAGE_PATH_DATA);
    const scroll = getDefaultScrollTarget();
    let data = dataRef.current;
    let count = data.loading ? 18 : data.items.length;
    const images = imagesRef.current;
    const cards = new Map<
      number,
      {
        card: CanvasCard;
        lines?: string[];
        yearWidth?: number;
        ratingWidth?: number;
        badgeWidth?: number;
        painted?: { amount: number; opacity: number; ready: boolean };
      }
    >();
    const transitions = new Map<
      number,
      { from: number; to: number; start: number }
    >();
    const systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = prefersReducedMotion();
    let controlDuration = motionDuration("control", canvas);
    let enterDuration = motionDuration("enter", canvas);
    let shimmerDuration = motionDuration("shimmer", canvas);
    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    const lowBandwidth =
      connection?.saveData ||
      /^(slow-2g|2g|3g)$/.test(connection?.effectiveType || "");
    let layoutWidth = host.clientWidth;
    let layout = canvasLayout(layoutWidth, count, posters);
    let offset = 0;
    let frame = 0;
    let hovered = -1;
    let disposed = false;
    let fullRedraw = true;
    let styleDirty = true;
    let fontFamily = "";
    let cardRadius = 0;
    let detailRadius = 0;
    let coverShade = 0;
    const colors = new Map<string, string>();
    const color = (name: string, fallback: string) =>
      colors.get(name) || fallback;

    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    };
    redrawRef.current = schedule;
    const cssEase = (t: number) => {
      let u = t;
      for (let i = 0; i < 5; i++) {
        const v = 1 - u;
        const x = 3 * v * v * u * 0.25 + 3 * v * u * u * 0.25 + u * u * u;
        const dx = 0.75 * v * v + 2.25 * u * u;
        if (Math.abs(dx) < 1e-6) break;
        u = Math.max(0, Math.min(1, u - (x - t) / dx));
      }
      const v = 1 - u;
      return 3 * v * v * u * 0.1 + 3 * v * u * u + u * u * u;
    };
    const progress = (index: number, now: number, duration: number) => {
      const transition = transitions.get(index);
      if (!transition) return index === hovered ? 1 : 0;
      const t =
        reducedMotion || duration <= 0
          ? 1
          : Math.min(1, (now - transition.start) / duration);
      return transition.from + (transition.to - transition.from) * cssEase(t);
    };
    const hover = (next: number) => {
      if (next === hovered) return;
      const now = performance.now();
      for (const index of [hovered, next]) {
        if (index >= 0)
          transitions.set(index, {
            from: progress(index, now, controlDuration),
            to: index === next ? 1 : 0,
            start: now,
          });
      }
      hovered = next;
      schedule();
    };
    resetRef.current = () => {
      if (dataRef.current === data) return;
      data = dataRef.current;
      count = data.loading ? 18 : data.items.length;
      layoutWidth = host.clientWidth;
      layout = canvasLayout(layoutWidth, count, posters);
      cards.clear();
      transitions.clear();
      hovered = -1;
      fullRedraw = true;
      host.style.height = `${layout.height}px`;
      schedule();
    };
    const coverSize = () => {
      const scale = 1.05 * (window.devicePixelRatio || 1);
      return {
        width: Math.ceil(layout.cardWidth * scale),
        height: Math.ceil(layout.cardHeight * scale),
      };
    };
    const rasterize = (url: string, entry: CoverImage, fallback?: string) => {
      entry.pending = true;
      const { signal } = entry.request;
      const source = entry.source
        ? Promise.resolve(entry.source)
        : fetchCover(url, signal).catch((error: unknown) => {
            if (!fallback || signal.aborted) throw error;
            return fetchCover(fallback, signal);
          });
      void source
        .then(async (blob) => {
          entry.source = blob;
          const size = coverSize();
          const byHeight = await decodeCover(blob, {
            resizeHeight: size.height,
            resizeQuality: "high",
          });
          if (byHeight.width >= size.width) return byHeight;
          byHeight.close();
          return decodeCover(blob, {
            resizeWidth: size.width,
            resizeQuality: "high",
          });
        })
        .then((bitmap) => {
          entry.pending = false;
          if (signal.aborted) {
            bitmap.close();
            return;
          }
          if (!entry.loadedAt) entry.loadedAt = performance.now();
          entry.bitmap?.close();
          entry.bitmap = bitmap;
          redrawRef.current();
        })
        .catch(() => {
          entry.pending = false;
          if (signal.aborted) return;
          entry.failed = !entry.bitmap;
          redrawRef.current();
        });
    };
    const coverUrl = (card: CanvasCard) =>
      lowBandwidth && card.smallCover ? card.smallCover : card.cover;
    const cover = (card: CanvasCard, url: string) => {
      let entry = images.get(url);
      if (entry) {
        images.delete(url);
      } else {
        entry = {
          source: null,
          bitmap: null,
          pending: false,
          failed: false,
          loadedAt: 0,
          request: new AbortController(),
        };
      }
      images.set(url, entry);
      if (entry.pending || entry.failed) return entry;
      const size = coverSize();
      if (
        !entry.bitmap ||
        entry.bitmap.width < size.width * 0.9 ||
        entry.bitmap.height < size.height * 0.9
      ) {
        rasterize(
          url,
          entry,
          card.cover && card.cover !== url ? card.cover : undefined,
        );
      }
      return entry;
    };
    function draw() {
      frame = 0;
      if (!host || !canvas || !ctx) return;
      const width = host.clientWidth;
      if (!width) return;
      if (width !== layoutWidth) {
        layoutWidth = width;
        layout = canvasLayout(width, count, posters);
        cards.clear();
        fullRedraw = true;
      }
      if (host.style.height !== `${layout.height}px`)
        host.style.height = `${layout.height}px`;
      const viewport =
        scroll instanceof HTMLElement
          ? {
              top: scroll.getBoundingClientRect().top,
              height: scroll.clientHeight,
            }
          : { top: 0, height: window.innerHeight };
      const hostTop = host.getBoundingClientRect().top;
      const windowed = canvasWindow(
        layout,
        viewport.top - hostTop,
        viewport.height,
      );
      const nextOffset = Math.floor(windowed.offset);
      const height = windowed.height
        ? Math.min(
            layout.height - nextOffset,
            Math.ceil(windowed.height + windowed.offset - nextOffset),
          )
        : 0;
      const shift = nextOffset - offset;
      offset = nextOffset;
      if (canvas.style.top !== `${offset}px`) canvas.style.top = `${offset}px`;
      if (canvas.style.height !== `${height}px`)
        canvas.style.height = `${height}px`;
      const dpr = window.devicePixelRatio || 1;
      const bitmapWidth = Math.ceil(width * dpr);
      const bitmapHeight = Math.ceil(height * dpr);
      if (canvas.width !== bitmapWidth) {
        canvas.width = bitmapWidth;
        fullRedraw = true;
      }
      if (canvas.height !== bitmapHeight) {
        canvas.height = bitmapHeight;
        fullRedraw = true;
      }
      if (!height) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (styleDirty) {
        reducedMotion = prefersReducedMotion();
        controlDuration = motionDuration("control", canvas);
        enterDuration = motionDuration("enter", canvas);
        shimmerDuration = motionDuration("shimmer", canvas);
        const style = getComputedStyle(canvas);
        fontFamily = style.fontFamily;
        cardRadius = parseFloat(style.getPropertyValue("--radius-item"));
        detailRadius = parseFloat(style.getPropertyValue("--radius-detail"));
        for (const name of [
          "--game-card-bg",
          "--skeleton-alt-from",
          "--skeleton-alt-via",
          "--game-cover-brightness",
          "--game-no-cover-line",
          "--game-card-overlay",
          "--game-info-text",
          "--color-green",
          "--color-yellow",
          "--color-red",
        ]) {
          colors.set(name, style.getPropertyValue(name).trim());
        }
        const brightness = Number(color("--game-cover-brightness", "1"));
        coverShade = Number.isFinite(brightness)
          ? Math.max(0, 1 - brightness)
          : 0;
        cards.clear();
        styleDirty = false;
        fullRedraw = true;
      }
      if (shift && !fullRedraw) {
        const pixels = shift * dpr;
        if (Math.abs(shift) >= height || !Number.isInteger(pixels)) {
          fullRedraw = true;
        } else {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = "copy";
          ctx.drawImage(canvas, 0, -pixels);
          ctx.restore();
          const top = shift > 0 ? height - shift : 0;
          const bottom = shift > 0 ? height : -shift;
          ctx.clearRect(0, top, width, bottom - top);
          for (const [index, entry] of cards) {
            const y =
              Math.floor(index / layout.columns) * layout.stride - offset;
            if (y < bottom && y + layout.cardHeight > top) delete entry.painted;
          }
        }
      }
      if (fullRedraw) ctx.clearRect(0, 0, width, height);
      const now = performance.now();
      let animating = false;
      const start = Math.floor(offset / layout.stride) * layout.columns;
      const end = Math.min(
        count,
        Math.ceil((offset + height) / layout.stride) * layout.columns,
      );
      const used = new Set<string>();
      for (let index = start; index < end; index++) {
        const amount = progress(index, now, controlDuration);
        const transition = transitions.get(index);
        if (transition) {
          if (!reducedMotion && now - transition.start < controlDuration)
            animating = true;
          else transitions.delete(index);
        }
        const x = (index % layout.columns) * (layout.cardWidth + layout.gap);
        const y = Math.floor(index / layout.columns) * layout.stride - offset;
        const w = layout.cardWidth;
        const h = layout.cardHeight;
        let entry = cards.get(index);
        if (!data.loading && !entry) {
          entry = { card: data.getCard(data.items[index]!) };
          cards.set(index, entry);
        }
        const card = entry?.card;
        const url = card && coverUrl(card);
        if (url) used.add(url);
        const image = card && url ? cover(card, url) : null;
        const bitmap = image?.bitmap ?? null;
        const ready = !!bitmap;
        const opacity =
          image && bitmap && !reducedMotion && enterDuration > 0
            ? cssEase(Math.min(1, (now - image.loadedAt) / enterDuration))
            : 1;
        if (opacity < 1) animating = true;
        const previous = entry?.painted;
        if (
          !fullRedraw &&
          !data.loading &&
          previous?.amount === amount &&
          previous.opacity === opacity &&
          previous.ready === ready
        )
          continue;
        if (entry) entry.painted = { amount, opacity, ready };
        if (!fullRedraw) ctx.clearRect(x, y, w, h);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, cardRadius);
        ctx.clip();
        ctx.fillStyle = color("--game-card-bg", "#222");
        ctx.fillRect(x, y, w, h);
        if (data.loading) {
          ctx.fillStyle = color("--skeleton-alt-from", "#333");
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = color("--skeleton-alt-via", "#555");
          ctx.beginPath();
          ctx.roundRect(x + 8, y + h - 22, w * 0.65, 8, detailRadius);
          ctx.fill();
          if (!reducedMotion && shimmerDuration > 0) {
            const left =
              x + (((now % shimmerDuration) / shimmerDuration) * 2 - 1) * w;
            const shimmer = ctx.createLinearGradient(left, 0, left + w, 0);
            shimmer.addColorStop(0, "transparent");
            shimmer.addColorStop(0.5, color("--skeleton-alt-via", "#555"));
            shimmer.addColorStop(1, "transparent");
            ctx.fillStyle = shimmer;
            ctx.fillRect(x, y, w, h);
            animating = true;
          }
        } else if (card && entry) {
          if (bitmap) {
            ctx.globalAlpha = opacity;
            const scale =
              Math.max(w / bitmap.width, h / bitmap.height) *
              (1 + 0.05 * amount);
            ctx.drawImage(
              bitmap,
              x + (w - bitmap.width * scale) / 2,
              y + (h - bitmap.height * scale) / 2,
              bitmap.width * scale,
              bitmap.height * scale,
            );
            const shade = coverShade * (1 - amount);
            if (shade > 0) {
              ctx.fillStyle = `rgba(0,0,0,${shade})`;
              ctx.fillRect(x, y, w, h);
            }
            ctx.globalAlpha = 1;
          } else {
            const iconSize = Math.min(36, w * 0.3, h * 0.2);
            ctx.save();
            ctx.translate(x + w / 2 - iconSize / 2, y + h / 2 - iconSize / 2);
            ctx.scale(iconSize / 24, iconSize / 24);
            ctx.fillStyle = color("--game-no-cover-line", "#888");
            ctx.fill(missingImagePath, "evenodd");
            ctx.restore();
          }
          const gradient = ctx.createLinearGradient(0, y + h * 0.6, 0, y + h);
          gradient.addColorStop(0, "transparent");
          gradient.addColorStop(1, "rgba(0,0,0,0.85)");
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, w, h);
          if (amount > 0) {
            ctx.globalAlpha = amount;
            ctx.fillStyle = color("--game-card-overlay", "transparent");
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
          }
          ctx.font = `300 10px ${fontFamily}`;
          ctx.textBaseline = "top";
          if (!entry.lines) {
            entry.lines = [];
            let line = "";
            for (const word of card.title.toLowerCase().trim().split(/\s+/)) {
              const next = line ? `${line} ${word}` : word;
              if (line && ctx.measureText(next).width > w - 16) {
                entry.lines.push(line);
                line = word;
              } else line = next;
            }
            entry.lines.push(line);
          }
          const lines = entry.lines;
          const hasMeta = posters && (card.year || card.rating || card.adult || card.badge);
          ctx.fillStyle = color("--game-info-text", "#f3f3f3");
          lines.forEach((text, row) =>
            ctx.fillText(
              text,
              x + 8,
              y + h - 8 -
                (hasMeta ? 16 : 0) -
                (card.resumeLabel ? 16 : 0) -
                (lines.length - row) * 14 + 2,
            ),
          );
          if (hasMeta) {
            const metaY = y + h - 18 - (card.resumeLabel ? 16 : 0);
            let left = x + 8;
            ctx.font = `400 10px ${fontFamily}`;
            if (card.year) {
              const year = String(card.year);
              ctx.fillText(year, left, metaY);
              left += (entry.yearWidth ??= ctx.measureText(year).width) + 6;
            }
            if (card.rating) {
              const rating = `★ ${card.rating}`;
              ctx.fillStyle = color(
                card.rating >= 8
                  ? "--color-green"
                  : card.rating >= 6
                    ? "--color-yellow"
                    : "--color-red",
                "#fff",
              );
              ctx.fillText(rating, left, metaY);
              left += (entry.ratingWidth ??= ctx.measureText(rating).width) + 6;
            }
            if (card.adult) {
              ctx.fillStyle = "rgba(239,68,68,0.85)";
              ctx.beginPath();
              ctx.roundRect(left, metaY - 2, 25, 14, detailRadius);
              ctx.fill();
              ctx.fillStyle = "#fff";
              ctx.fillText("18+", left + 3, metaY);
              left += 31;
            }
            if (card.badge) {
              const badgeWidth = (entry.badgeWidth ??= ctx.measureText(card.badge).width) + 8;
              ctx.fillStyle = "rgba(255,255,255,0.18)";
              ctx.beginPath();
              ctx.roundRect(left, metaY - 2, badgeWidth, 14, detailRadius);
              ctx.fill();
              ctx.fillStyle = color("--game-info-text", "#f3f3f3");
              ctx.fillText(card.badge, left + 4, metaY);
            }
          }
          if (card.resumeLabel) {
            ctx.font = `400 10px ${fontFamily}`;
            ctx.fillStyle = color("--game-info-text", "#f3f3f3");
            ctx.fillText(card.resumeLabel, x + 8, y + h - 18, w - 16);
          }
        }
        ctx.restore();
      }
      fullRedraw = false;
      const ahead = 2 * layout.columns;
      const keepStart = Math.max(0, start - ahead);
      const keepEnd = Math.min(count, end + ahead);
      if (!data.loading) {
        for (let index = keepStart; index < keepEnd; index++) {
          if (index >= start && index < end) continue;
          let entry = cards.get(index);
          if (!entry) {
            entry = { card: data.getCard(data.items[index]!) };
            cards.set(index, entry);
          }
          const url = coverUrl(entry.card);
          if (!url) continue;
          used.add(url);
          cover(entry.card, url);
        }
      }
      for (const [index, entry] of cards) {
        if (index < keepStart || index >= keepEnd) cards.delete(index);
        else if (index < start || index >= end) delete entry.painted;
      }
      for (const index of transitions.keys()) {
        if (index < start || index >= end) transitions.delete(index);
      }
      if (animating) schedule();
      let bitmapBytes = 0;
      for (const entry of images.values()) {
        if (entry.bitmap)
          bitmapBytes += entry.bitmap.width * entry.bitmap.height * 4;
      }
      for (const [url, entry] of images) {
        if (bitmapBytes <= COVER_BITMAP_BUDGET) break;
        if (!entry.bitmap || used.has(url)) continue;
        bitmapBytes -= entry.bitmap.width * entry.bitmap.height * 4;
        entry.bitmap.close();
        entry.bitmap = null;
      }
      for (const [url, entry] of images) {
        if (images.size <= Math.max(MAX_COVERS, used.size)) break;
        if (!used.has(url)) {
          releaseCover(entry);
          images.delete(url);
        }
      }
    }
    const hit = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return data.loading
        ? -1
        : canvasHit(
            layout,
            count,
            event.clientX - rect.left,
            event.clientY - rect.top + offset,
          );
    };
    const move = (event: MouseEvent) => {
      const next = hit(event);
      hover(next);
      canvas.style.cursor = next < 0 ? "default" : "pointer";
    };
    const leave = () => hover(-1);
    const click = (event: MouseEvent) => {
      const index = hit(event);
      if (index >= 0) selectionRef.current(data.items[index]!);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    const invalidateStyle = () => {
      styleDirty = true;
      schedule();
    };
    const theme = new MutationObserver(invalidateStyle);
    for (const node of [document.documentElement, document.body]) {
      theme.observe(node, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme", "data-motion"],
      });
    }
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.fonts.addEventListener("loadingdone", invalidateStyle);
    systemMotion.addEventListener("change", invalidateStyle);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseleave", leave);
    canvas.addEventListener("click", click);
    host.style.height = `${layout.height}px`;
    schedule();
    return () => {
      resetRef.current = () => {};
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.fonts.removeEventListener("loadingdone", invalidateStyle);
      systemMotion.removeEventListener("change", invalidateStyle);
      canvas.removeEventListener("mousemove", move);
      canvas.removeEventListener("mouseleave", leave);
      canvas.removeEventListener("click", click);
    };
  }, [posters, active]);

  useLayoutEffect(() => resetRef.current(), [items, getCard, loading]);

  return (
    <div ref={hostRef} class="catalog-canvas-area">
      <canvas ref={canvasRef} class="catalog-canvas" />
    </div>
  );
}
