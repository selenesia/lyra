import type { RefObject } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export default function ChatTooltip({ containerRef }: { containerRef: RefObject<HTMLElement> }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [label, setLabel] = useState("");
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const show = (event: Event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null;
      if (!button || button.matches(":disabled")) return;
      setTarget(button);
      setLabel(button.dataset.tooltip ?? "");
    };
    const leave = (event: Event) => {
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (related instanceof Node && (event.target as Element).closest("[data-tooltip]")?.contains(related)) return;
      setTarget(null);
    };
    const hide = () => setTarget(null);
    const sync = (records: MutationRecord[]) => {
      for (const record of records) {
        const button = record.target;
        if (!(button instanceof HTMLElement) || !button.matches("[data-tooltip]") || button.matches(":disabled")) continue;
        if (!button.matches(":hover, :focus-visible")) continue;
        setTarget(button);
        setLabel(button.dataset.tooltip ?? "");
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(container, { attributes: true, attributeFilter: ["data-tooltip"], subtree: true });
    container.addEventListener("pointerover", show);
    container.addEventListener("focusin", show);
    container.addEventListener("pointerout", leave);
    container.addEventListener("focusout", leave);
    container.addEventListener("pointerdown", hide);
    container.addEventListener("keydown", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      observer.disconnect();
      container.removeEventListener("pointerover", show);
      container.removeEventListener("focusin", show);
      container.removeEventListener("pointerout", leave);
      container.removeEventListener("focusout", leave);
      container.removeEventListener("pointerdown", hide);
      container.removeEventListener("keydown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [containerRef]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!target || !tooltip) return;
    const rect = target.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tooltip.offsetWidth / 2, window.innerWidth - tooltip.offsetWidth - 8));
    const below = rect.top < tooltip.offsetHeight + 16;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${below ? rect.bottom + 9 : rect.top - tooltip.offsetHeight - 9}px`;
    tooltip.style.setProperty("--chat-tooltip-arrow", `${rect.left + rect.width / 2 - left}px`);
    tooltip.classList.toggle("is-below", below);
    target.setAttribute("aria-describedby", "chat-tooltip");
    return () => target.removeAttribute("aria-describedby");
  }, [target, label]);

  return target && createPortal(
    <div id="chat-tooltip" class="chat-tooltip" role="tooltip" ref={tooltipRef}>{label}</div>,
    document.body,
  );
}
