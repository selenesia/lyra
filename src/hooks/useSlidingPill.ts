import { useLayoutEffect, useState } from "preact/hooks";

export function useSlidingPill(activeSelector: string, selected: unknown) {
  const [track, setTrack] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!track) return;
    const place = () => {
      const active = track.querySelector<HTMLElement>(activeSelector);
      if (!active || active.offsetWidth === 0) return;
      track.style.setProperty("--pill-x", `${active.offsetLeft}px`);
      track.style.setProperty("--pill-y", `${active.offsetTop}px`);
      track.style.setProperty("--pill-w", `${active.offsetWidth}px`);
      track.style.setProperty("--pill-h", `${active.offsetHeight}px`);
      if (!track.classList.contains("is-placed")) {
        void track.offsetWidth;
        track.classList.add("is-placed");
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(track);
    return () => observer.disconnect();
  }, [track, selected, activeSelector]);

  return setTrack;
}
