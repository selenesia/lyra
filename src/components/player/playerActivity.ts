import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";

interface ControlsActivityContext {
  containerRef: MutableRef<HTMLDivElement | null>;
  controlsFrameRef: MutableRef<number | null>;
  resetTimer: () => void;
  clearHideTimer: () => void;
  selectorOpenRef: MutableRef<boolean>;
  scrubbingRef: MutableRef<boolean>;
  volumeDraggingRef: MutableRef<boolean>;
  setShowControls: Dispatch<StateUpdater<boolean>>;
}

export function attachControlsActivity({
  containerRef, controlsFrameRef, resetTimer, clearHideTimer, selectorOpenRef,
  scrubbingRef, volumeDraggingRef, setShowControls,
}: ControlsActivityContext) {
  const container = containerRef.current;
  if (!container) return;
  const handleMouseMove = () => {
    if (controlsFrameRef.current !== null) return;
    controlsFrameRef.current = requestAnimationFrame(() => {
      controlsFrameRef.current = null;
      resetTimer();
    });
  };
  const handleMouseLeave = () => {
    if (controlsFrameRef.current !== null) {
      cancelAnimationFrame(controlsFrameRef.current);
      controlsFrameRef.current = null;
    }
    clearHideTimer();
    if (
      !selectorOpenRef.current &&
      !scrubbingRef.current &&
      !volumeDraggingRef.current &&
      !container.querySelector(":focus-visible")
    )
      setShowControls(false);
  };
  const finishVolumeDrag = () => {
    if (!volumeDraggingRef.current) return;
    volumeDraggingRef.current = false;
    resetTimer();
  };
  window.addEventListener("pointerup", finishVolumeDrag);
  window.addEventListener("pointercancel", finishVolumeDrag);
  window.addEventListener("blur", finishVolumeDrag);
  container.addEventListener("pointermove", handleMouseMove);
  container.addEventListener("pointerdown", handleMouseMove);
  container.addEventListener("pointerleave", handleMouseLeave);
  container.addEventListener("focusin", resetTimer);
  container.addEventListener("focusout", resetTimer);
  resetTimer();
  return () => {
    window.removeEventListener("pointerup", finishVolumeDrag);
    window.removeEventListener("pointercancel", finishVolumeDrag);
    window.removeEventListener("blur", finishVolumeDrag);
    container.removeEventListener("pointermove", handleMouseMove);
    container.removeEventListener("pointerdown", handleMouseMove);
    container.removeEventListener("pointerleave", handleMouseLeave);
    container.removeEventListener("focusin", resetTimer);
    container.removeEventListener("focusout", resetTimer);
    if (controlsFrameRef.current !== null) {
      cancelAnimationFrame(controlsFrameRef.current);
      controlsFrameRef.current = null;
    }
  };
}
