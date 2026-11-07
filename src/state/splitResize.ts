export function initSplitResize() {
  const container = document.getElementById("iframe-container");
  if (!container) return;
  const handleWidth = 10;
  let cachedContainerRect: DOMRect | null = null;
  let cachedGap = 0;
  let cachedLeftIframe: Element | null = null;
  let resizeRaf: number | null = null;
  let pendingLeftPercent: number | null = null;

  const getLeftIframe = () => {
    if (cachedLeftIframe && cachedLeftIframe.isConnected) {
      return cachedLeftIframe;
    }
    cachedLeftIframe = document.querySelector(".iframe.active-split-left");
    return cachedLeftIframe;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!cachedContainerRect) {
      cachedContainerRect = container.getBoundingClientRect();
      const containerStyle = window.getComputedStyle(container);
      cachedGap = parseFloat(containerStyle.gap) || 0;
    }
    const containerRect = cachedContainerRect;
    if (!containerRect) return;
    const newLeftWidth = e.clientX - containerRect.left;
    const totalWidthWithoutGap = containerRect.width - cachedGap;
    let percent = (newLeftWidth / totalWidthWithoutGap) * 100;
    percent = Math.max(20, Math.min(80, percent));
    pendingLeftPercent = percent;
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (pendingLeftPercent === null) return;
      const leftIframe = getLeftIframe();
      if (leftIframe) {
        (leftIframe as HTMLElement).style.flexBasis =
          `${pendingLeftPercent}%`;
      }
      pendingLeftPercent = null;
    });
  };

  const onMouseUp = () => {
    cachedContainerRect = null;
    cachedGap = 0;
    pendingLeftPercent = null;
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = null;
    }
    document.body.classList.remove("is-resizing");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };

  let cursorRaf: number | null = null;
  container.addEventListener("mousemove", (e: MouseEvent) => {
    if (document.body.classList.contains("is-resizing")) return;
    if (!document.body.classList.contains("split-view")) {
      container.style.cursor = "default";
      cachedLeftIframe = null;
      return;
    }
    if (cursorRaf) return;
    const clientX = e.clientX;
    cursorRaf = requestAnimationFrame(() => {
      cursorRaf = null;
      const leftIframe = getLeftIframe();
      if (!leftIframe) {
        container.style.cursor = "default";
        return;
      }
      const leftIframeRect = leftIframe.getBoundingClientRect();
      const handleGripLeft = leftIframeRect.right - handleWidth / 2;
      const handleGripRight = leftIframeRect.right + handleWidth / 2;
      container.style.cursor =
        clientX >= handleGripLeft && clientX <= handleGripRight
          ? "col-resize"
          : "default";
    });
  });

  container.addEventListener("mousedown", (e: MouseEvent) => {
    if (!document.body.classList.contains("split-view")) return;
    const leftIframe = getLeftIframe();
    if (!leftIframe) return;
    const leftIframeRect = leftIframe.getBoundingClientRect();
    const handleGripLeft = leftIframeRect.right - handleWidth / 2;
    const handleGripRight = leftIframeRect.right + handleWidth / 2;
    if (e.clientX >= handleGripLeft && e.clientX <= handleGripRight) {
      e.preventDefault();
      document.body.classList.add("is-resizing");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }
  });
}
