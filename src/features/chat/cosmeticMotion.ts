import { useEffect, useRef, useState } from "preact/hooks";
import { prefersReducedMotion } from "../../core/config/advancedSettings.ts";

interface MotionTarget {
  visible: boolean;
  update: (active: boolean) => void;
}

const targets = new Map<Element, MotionTarget>();
let observer: IntersectionObserver | null = null;
let media: MediaQueryList | null = null;

function updateMotion() {
  const enabled = !document.hidden && !prefersReducedMotion();
  for (const target of targets.values()) target.update(enabled && target.visible);
}

export function observeCosmeticMotion(element: Element, update: (active: boolean) => void): () => void {
  if (!targets.size) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = targets.get(entry.target);
        if (target) target.visible = entry.isIntersecting && entry.intersectionRatio > 0;
      }
      updateMotion();
    });
    media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateMotion);
    document.addEventListener("motionPreferenceUpdated", updateMotion);
  }
  targets.set(element, { visible: false, update });
  observer!.observe(element);
  return () => {
    observer?.unobserve(element);
    targets.delete(element);
    if (targets.size) return;
    observer?.disconnect();
    observer = null;
    media?.removeEventListener("change", updateMotion);
    media = null;
    document.removeEventListener("visibilitychange", updateMotion);
    document.removeEventListener("motionPreferenceUpdated", updateMotion);
  };
}

export function useCosmeticMotion<T extends HTMLElement>(wanted: boolean) {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(false);
    if (!wanted || !ref.current) return;
    return observeCosmeticMotion(ref.current, setActive);
  }, [wanted]);
  return { ref, moving: wanted && active };
}
