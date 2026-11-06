import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { showHomeView } from "../state/store.ts";
import { attachSearchLight } from "../core/ui/searchLight.ts";
import {
  closeSettingsModalIfOpen,
  getDefaultScrollTarget,
  getScrollTop,
  hasBlockingModalOpen,
  setElementHtml,
  setScrollTop,
  type ScrollTarget,
} from "../core/ui/dom.ts";

interface MenuViewOptions {
  bodyClass: string;
  signal: { value: boolean };
  iconId: string;
  inactiveIcon: string;
  activeIcon: string;
  openedStorageKey: string;
  hideOtherViews?: () => void;
  interceptEscape?: () => boolean;
  onShowFrame?: () => void;
  showOnMount?: boolean;
}

interface MenuViewState {
  visible: boolean;
  searchBarRef: preact.RefObject<HTMLDivElement>;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

const SCROLL_SHADOW_THRESHOLD = 48;

export function useMenuView({
  bodyClass,
  signal,
  iconId,
  inactiveIcon,
  activeIcon,
  openedStorageKey,
  hideOtherViews,
  interceptEscape,
  onShowFrame,
  showOnMount = false,
}: MenuViewOptions): MenuViewState {
  const [visible, setVisible] = useState(false);
  const searchBarRef = useRef<HTMLDivElement | null>(null);
  const scrollTargetRef = useRef<ScrollTarget | null>(null);
  const savedScrollRef = useRef(0);
  const didShowOnMountRef = useRef(false);

  const hide = useCallback(() => {
    if (!document.body.classList.contains(bodyClass)) return;

    const target = scrollTargetRef.current;
    if (target) savedScrollRef.current = getScrollTop(target);

    signal.value = false;
    setVisible(false);
    document.body.classList.remove(bodyClass);

    setElementHtml(iconId, inactiveIcon);
  }, [bodyClass, iconId, inactiveIcon, signal]);

  const show = useCallback(() => {
    closeSettingsModalIfOpen();
    hideOtherViews?.();

    showHomeView();
    document.body.classList.add(bodyClass);
    signal.value = true;
    setVisible(true);

    requestAnimationFrame(() => {
      const target = scrollTargetRef.current;
      if (target) setScrollTop(target, savedScrollRef.current);
      localStorage.setItem(openedStorageKey, "true");
      onShowFrame?.();
    });

    setElementHtml(iconId, activeIcon);
  }, [
    activeIcon,
    bodyClass,
    hideOtherViews,
    iconId,
    onShowFrame,
    openedStorageKey,
    signal,
  ]);

  const toggle = useCallback(() => {
    if (document.body.classList.contains(bodyClass)) hide();
    else show();
  }, [bodyClass, hide, show]);

  useEffect(() => {
    if (!showOnMount || didShowOnMountRef.current) return;
    didShowOnMountRef.current = true;
    show();
  }, [show, showOnMount]);

  useEffect(() => {
    if (searchBarRef.current) return attachSearchLight(searchBarRef.current);
    return undefined;
  }, [visible]);

  useEffect(() => {
    scrollTargetRef.current = getDefaultScrollTarget();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const target = scrollTargetRef.current;
    const bar = searchBarRef.current;
    if (!target || !bar) return;
    const topbar = bar.parentElement;

    const updateStickyState = () => {
      const scrollTop = getScrollTop(target);
      const isSticky = scrollTop > 10;
      const hasScrollShadow = scrollTop > SCROLL_SHADOW_THRESHOLD;
      if (bar.classList.contains("is-sticky") !== isSticky) {
        bar.classList.toggle("is-sticky", isSticky);
      }
      if (
        topbar &&
        topbar.classList.contains("has-scroll-shadow") !== hasScrollShadow
      ) {
        topbar.classList.toggle("has-scroll-shadow", hasScrollShadow);
      }
    };
    updateStickyState();

    let scrollRaf: number | null = null;
    const onScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        updateStickyState();
      });
    };

    target.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      target.removeEventListener("scroll", onScroll);
      bar.classList.remove("is-sticky");
      topbar?.classList.remove("has-scroll-shadow");
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || hasBlockingModalOpen()) return;
      if (interceptEscape?.()) return;
      hide();
    };

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [hide, interceptEscape, visible]);

  return { visible, searchBarRef, show, hide, toggle };
}
