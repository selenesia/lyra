import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useManagedModal } from "../../core/ui/modal.ts";
import { IconCrossMedium } from "../icons";

export interface ChatMediaView {
  id: string;
  src: string;
  type: string;
  width: number;
  height: number;
}

interface ZoomAnchor {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

const DRAG_SLOP = 4;
const MAX_ZOOM = 4;
const WHEEL_ZOOM_RATE = 0.002;
const KEY_ZOOM_FACTOR = 1.5;

function downloadName({ id, type }: ChatMediaView): string {
  const extension = type.split("/")[1]?.split(/[;+]/)[0] || "img";
  return `chat-${id}.${extension}`;
}

function clampZoom(scale: number, fitScale: number): number {
  return scale > fitScale ? Math.min(MAX_ZOOM, scale) : 0;
}

function wheelZoomFactor(delta: number): number {
  return Math.min(2, Math.max(0.5, Math.exp(-delta * WHEEL_ZOOM_RATE)));
}

export default function ChatMediaViewer({ media, onClose }: { media: ChatMediaView; onClose: () => void }) {
  const [isClosing, setIsClosing] = useState(false);
  const [scale, setScale] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<ZoomAnchor | null>(null);
  const fitScaleRef = useRef(1);
  const scaleRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);

  const requestClose = useCallback(() => setIsClosing(true), []);
  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: true,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: onClose,
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image || scale !== 0) return;
    const measure = () => {
      fitScaleRef.current = Math.max(0.01, Math.min(1, image.clientWidth / media.width));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [media.width, scale]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!scale || !stage || !anchor) return;
    const rect = stage.getBoundingClientRect();
    stage.scrollLeft = anchor.x * stage.scrollWidth - (anchor.clientX - rect.left);
    stage.scrollTop = anchor.y * stage.scrollHeight - (anchor.clientY - rect.top);
  }, [scale]);

  const commitScale = useCallback((next: number, anchor?: ZoomAnchor | null) => {
    const target = clampZoom(next, fitScaleRef.current);
    if (target === scaleRef.current) {
      anchorRef.current = null;
      return;
    }
    scaleRef.current = target;
    anchorRef.current = anchor ?? null;
    setScale(target);
  }, []);

  const imageAnchor = useCallback((clientX: number, clientY: number): ZoomAnchor | null => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
      clientX,
      clientY,
    };
  }, []);

  const centerAnchor = useCallback((): ZoomAnchor | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return imageAnchor(rect.left + stage.clientWidth / 2, rect.top + stage.clientHeight / 2);
  }, [imageAnchor]);

  const zoomBy = useCallback(
    (factor: number, anchor: ZoomAnchor | null) => {
      const current = scaleRef.current || fitScaleRef.current;
      if (!Number.isFinite(factor) || factor <= 0) return;
      commitScale(current * factor, anchor);
    },
    [commitScale],
  );

  const toggleZoom = useCallback(
    (anchor: ZoomAnchor) => {
      if (scaleRef.current >= MAX_ZOOM - 0.01) {
        commitScale(0);
        return;
      }
      zoomBy(2, anchor);
    },
    [commitScale, zoomBy],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const delta =
        event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * stage.clientHeight : event.deltaY;
      zoomBy(wheelZoomFactor(delta), imageAnchor(event.clientX, event.clientY));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [imageAnchor, zoomBy]);

  const stopDrag = () => {
    stageRef.current?.classList.remove("is-dragging");
  };

  return (
    <div
      class={`popup chat-media-viewer ${modalStateClass}`}
      role="dialog"
      aria-modal="true"
      aria-label="image viewer"
      onAnimationEnd={onAnimationEnd}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div class="chat-media-frame">
        <div
          ref={stageRef}
          class={`chat-media-stage is-zoomable${scale ? " is-zoomed" : ""}`}
          tabIndex={scale ? 0 : undefined}
          onPointerDown={(event) => {
            const stage = stageRef.current;
            dragRef.current = null;
            if (!scale || !stage || event.pointerType !== "mouse" || event.button !== 0) return;
            event.preventDefault();
            dragRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
            stage.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            const stage = stageRef.current;
            if (!drag || !stage) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
            drag.moved = true;
            stage.classList.add("is-dragging");
            stage.scrollLeft = drag.left - dx;
            stage.scrollTop = drag.top - dy;
          }}
          onPointerUp={stopDrag}
          onPointerCancel={() => {
            dragRef.current = null;
            stopDrag();
          }}
          onKeyDown={(event) => {
            if (!scale) return;
            if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              zoomBy(KEY_ZOOM_FACTOR, centerAnchor());
            } else if (event.key === "-" || event.key === "_") {
              event.preventDefault();
              zoomBy(1 / KEY_ZOOM_FACTOR, centerAnchor());
            } else if (event.key === "0") {
              event.preventDefault();
              commitScale(0);
            }
          }}
          onClick={(event) => {
            const moved = dragRef.current?.moved;
            dragRef.current = null;
            if (moved) return;
            const anchor = imageAnchor(event.clientX, event.clientY);
            if (anchor) toggleZoom(anchor);
          }}
        >
          <img
            ref={imageRef}
            src={media.src}
            alt="chat attachment"
            width={media.width}
            height={media.height}
            style={`--media-width:${media.width}px;--media-ratio:${media.width / media.height};--media-scale:${scale || 1}`}
            decoding="async"
            draggable={false}
          />
        </div>
        <div class="chat-media-bar">
          <span class="chat-media-size">
            {media.width} × {media.height}
          </span>
          <div class="chat-media-actions">
            <a class="settings-page-button" href={media.src} target="_blank" rel="noopener noreferrer">
              open original
            </a>
            <a class="settings-page-button" href={media.src} download={downloadName(media)}>
              download
            </a>
          </div>
        </div>
      </div>
      <button ref={closeRef} type="button" class="modal-close-btn" aria-label="close" onClick={requestClose}>
        <IconCrossMedium />
      </button>
    </div>
  );
}
