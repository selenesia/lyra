export type ScrollTarget = HTMLElement | Window;

function isWindowTarget(target: ScrollTarget): target is Window {
  return target === window;
}

export function getDefaultScrollTarget(): ScrollTarget {
  return document.querySelector<HTMLElement>(".meow") || window;
}

export function getScrollTop(target: ScrollTarget): number {
  return isWindowTarget(target)
    ? window.scrollY || document.documentElement.scrollTop
    : target.scrollTop;
}

export function setScrollTop(target: ScrollTarget, value: number): void {
  if (isWindowTarget(target)) {
    window.scrollTo(0, value);
    return;
  }

  target.scrollTop = value;
}

export function setElementHtml(id: string, html: string): void {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

export function hasBlockingModalOpen(): boolean {
  return Array.from(document.querySelectorAll(".popup")).some(
    (el) => (el as HTMLElement).offsetHeight > 0,
  );
}
