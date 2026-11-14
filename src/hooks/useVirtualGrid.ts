import type { RefObject } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  getDefaultScrollTarget,
  getScrollTop,
  type ScrollTarget,
} from "../core/ui/dom.ts";

const INITIAL_ITEM_COUNT = 18;
const OVERSCAN_ROWS = 2;

interface VirtualGridRange {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
}

function scrollViewport(target: ScrollTarget): {
  top: number;
  height: number;
} {
  if (target instanceof HTMLElement) {
    const rect = target.getBoundingClientRect();
    return { top: rect.top, height: target.clientHeight };
  }
  return { top: 0, height: window.innerHeight };
}

export function useVirtualGrid<T>(
  items: readonly T[],
  enabled: boolean,
  scrollContainerRef?: RefObject<HTMLElement>,
) {
  const gridRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef({
    columns: 1,
    rowHeight: 0,
    rowGap: 0,
    gridOffset: 0,
    viewportHeight: 0,
  });
  const frameRef = useRef<number | null>(null);
  const updateRef = useRef<(() => void) | null>(null);
  const [range, setRange] = useState<VirtualGridRange>(() => ({
    start: 0,
    end: Math.min(INITIAL_ITEM_COUNT, items.length),
    topSpacer: 0,
    bottomSpacer: 0,
  }));

  useEffect(() => {
    setRange({
      start: 0,
      end: Math.min(INITIAL_ITEM_COUNT, items.length),
      topSpacer: 0,
      bottomSpacer: 0,
    });
  }, [items.length]);

  useEffect(() => {
    if (!enabled) return;
    const grid = gridRef.current;
    if (!grid) return;
    const scrollTarget =
      scrollContainerRef?.current ?? getDefaultScrollTarget();
    let needsMeasure = true;

    const measure = () => {
      const style = getComputedStyle(grid);
      const columns = Math.max(
        1,
        style.gridTemplateColumns
          .split(/\s+/)
          .filter((track) => track && track !== "none").length,
      );
      const card = Array.from(grid.children).find(
        (child) =>
          !child.classList.contains("catalog-virtual-spacer") &&
          !child.classList.contains("episode-picker-virtual-spacer") &&
          !child.classList.contains("chat-cosmetic-virtual-spacer"),
      ) as HTMLElement | undefined;
      const zoom = grid.getBoundingClientRect().width / grid.offsetWidth || 1;
      const rowHeight = (card?.getBoundingClientRect().height ?? 0) / zoom;
      const rowGap = Number.parseFloat(style.rowGap) || 0;
      if (rowHeight <= 0) return false;

      const gridRect = grid.getBoundingClientRect();
      const viewport = scrollViewport(scrollTarget);
      layoutRef.current = {
        columns,
        rowHeight,
        rowGap,
        gridOffset: scrollTarget === grid ? 0 : (gridRect.top - viewport.top) / zoom + getScrollTop(scrollTarget),
        viewportHeight: viewport.height,
      };
      return true;
    };

    const update = () => {
      frameRef.current = null;
      if (needsMeasure) needsMeasure = !measure();

      const { columns, rowHeight, rowGap, gridOffset, viewportHeight } =
        layoutRef.current;
      if (rowHeight <= 0) return;

      const stride = rowHeight + rowGap;
      const visibleTop = Math.max(0, getScrollTop(scrollTarget) - gridOffset);
      const visibleBottom = visibleTop + viewportHeight;
      const totalRows = Math.ceil(items.length / columns);
      const startRow = Math.max(
        0,
        Math.floor(visibleTop / stride) - OVERSCAN_ROWS,
      );
      const endRow = Math.min(
        totalRows,
        Math.ceil(visibleBottom / stride) + OVERSCAN_ROWS,
      );
      const start = Math.min(items.length, startRow * columns);
      const end = Math.min(items.length, endRow * columns);
      const remainingRows = Math.max(0, totalRows - endRow);
      const topSpacer = startRow > 0 ? startRow * stride - rowGap : 0;
      const bottomSpacer =
        remainingRows > 0 ? remainingRows * stride - rowGap : 0;

      setRange((current) =>
        current.start === start &&
        current.end === end &&
        current.topSpacer === topSpacer &&
        current.bottomSpacer === bottomSpacer
          ? current
          : { start, end, topSpacer, bottomSpacer },
      );
    };

    const scheduleUpdate = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(update);
    };

    const scheduleMeasure = () => {
      needsMeasure = true;
      scheduleUpdate();
    };
    updateRef.current = scheduleUpdate;

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(grid);
    scrollTarget.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleMeasure, { passive: true });
    scheduleUpdate();

    return () => {
      resizeObserver.disconnect();
      scrollTarget.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleMeasure);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      updateRef.current = null;
    };
  }, [enabled, items.length, scrollContainerRef]);

  const visibleItems = useMemo(
    () => items.slice(range.start, range.end),
    [items, range.end, range.start],
  );

  const scrollToIndex = (index: number) => {
    const { columns, rowHeight, rowGap, gridOffset, viewportHeight } = layoutRef.current;
    if (!rowHeight) return;
    const target = scrollContainerRef?.current ?? getDefaultScrollTarget();
    const top = gridOffset + Math.floor(index / columns) * (rowHeight + rowGap);
    const current = getScrollTop(target);
    const next = top < current ? top : top + rowHeight > current + viewportHeight ? top + rowHeight - viewportHeight : current;
    if (target instanceof HTMLElement) target.scrollTop = next;
    else target.scrollTo({ top: next, behavior: "instant" });
    updateRef.current?.();
  };

  return { gridRef, range, visibleItems, scrollToIndex };
}
