const LINE_HEIGHT = 1.45;
const CONTROLS_GAP = 12;
const ASS_OVERRIDE = /\{\\[^}]*\}/g;
const ASS_TOP_ALIGNMENT = /\{[^}]*\\an[789][^}]*\}/;

export interface CaptionCue {
  text: string;
  startTime: number;
  endTime: number;
  line?: number | "auto";
  snapToLines?: boolean;
  lineAlign?: string;
  position?: number | "auto";
  positionAlign?: string;
  size?: number;
  align?: string;
  getCueAsHTML?: () => DocumentFragment;
}

export interface CaptionPlacement {
  left: number;
  width: number;
  textAlign: "start" | "center" | "end" | "left" | "right";
  edge: "stack" | "top" | "bottom";
  offset: number;
  unit: "%" | "lines";
  shift: number;
}

export interface CaptionView {
  controlsVisible: boolean;
  sample: string | null;
}

export interface CaptionRenderer {
  update(view: CaptionView): void;
  destroy(): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function pictureBox(
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
) {
  if (!(width > 0 && height > 0 && videoWidth > 0 && videoHeight > 0)) {
    return { left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, height) };
  }
  const wide = width * videoHeight > height * videoWidth;
  const pictureWidth = wide ? (height * videoWidth) / videoHeight : width;
  const pictureHeight = wide ? height : (width * videoHeight) / videoWidth;
  return {
    left: (width - pictureWidth) / 2,
    top: (height - pictureHeight) / 2,
    width: pictureWidth,
    height: pictureHeight,
  };
}

export function captionFontSize(pictureWidth: number): number {
  return clamp(pictureWidth * 0.022, 15, 36);
}

export function captionText(text: string): string {
  return text.replace(ASS_OVERRIDE, "");
}

export function cuePlacement(cue: CaptionCue): CaptionPlacement {
  const align = cue.align || "center";
  const textAlign =
    align === "start" || align === "end" || align === "left" || align === "right"
      ? align
      : "center";
  const size = clamp(Number.isFinite(cue.size) ? (cue.size as number) : 100, 1, 100);
  const anchor =
    cue.positionAlign && cue.positionAlign !== "auto"
      ? cue.positionAlign
      : textAlign === "start" || textAlign === "left"
        ? "line-left"
        : textAlign === "end" || textAlign === "right"
          ? "line-right"
          : "center";
  const position =
    typeof cue.position === "number" && Number.isFinite(cue.position)
      ? clamp(cue.position, 0, 100)
      : anchor === "line-left"
        ? 0
        : anchor === "line-right"
          ? 100
          : 50;
  const left = clamp(
    anchor === "line-left"
      ? position
      : anchor === "line-right"
        ? position - size
        : position - size / 2,
    0,
    100 - size,
  );
  const horizontal = { left, width: size, textAlign } as const;
  const line = cue.line;
  if (typeof line !== "number" || !Number.isFinite(line)) {
    return ASS_TOP_ALIGNMENT.test(cue.text)
      ? { ...horizontal, edge: "top", offset: 0, unit: "lines", shift: 0 }
      : { ...horizontal, edge: "stack", offset: 0, unit: "lines", shift: 0 };
  }
  if (cue.snapToLines === false) {
    return {
      ...horizontal,
      edge: "top",
      offset: clamp(line, 0, 100),
      unit: "%",
      shift: cue.lineAlign === "center" ? -50 : cue.lineAlign === "end" ? -100 : 0,
    };
  }
  return line >= 0
    ? { ...horizontal, edge: "top", offset: line, unit: "lines", shift: 0 }
    : { ...horizontal, edge: "bottom", offset: -line - 1, unit: "lines", shift: 0 };
}

function isCaptionTrack(track: TextTrack): boolean {
  return track.kind === "subtitles" || track.kind === "captions";
}

function stripOverrides(node: Node): void {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const value = text.nodeValue || "";
    const cleaned = captionText(value);
    if (cleaned !== value) text.nodeValue = cleaned;
  }
}

function buildCue(cue: CaptionCue): HTMLElement {
  const placement = cuePlacement(cue);
  const element = document.createElement("div");
  element.className = "player-caption-cue";
  element.style.marginLeft = `${placement.left}%`;
  element.style.width = `${placement.width}%`;
  element.style.textAlign = placement.textAlign;
  if (placement.edge !== "stack") {
    element.dataset.placed = "true";
    const offset =
      placement.unit === "%"
        ? `${placement.offset}%`
        : `${placement.offset * LINE_HEIGHT}em`;
    element.style.setProperty(placement.edge, offset);
    if (placement.shift) element.style.transform = `translateY(${placement.shift}%)`;
  }
  const text = document.createElement("span");
  text.className = "player-caption-text";
  let fragment: DocumentFragment | null = null;
  try {
    fragment = cue.getCueAsHTML?.() ?? null;
  } catch {
    fragment = null;
  }
  if (fragment) {
    stripOverrides(fragment);
    text.append(fragment);
  } else {
    text.textContent = captionText(cue.text.replace(/<[^>]*>/g, ""));
  }
  element.append(text);
  return element;
}

export function attachCaptionRenderer(
  video: HTMLVideoElement,
  layer: HTMLElement,
  controls: HTMLElement,
): CaptionRenderer {
  const free = document.createElement("div");
  free.className = "player-caption-free";
  const stack = document.createElement("div");
  stack.className = "player-caption-stack";
  layer.replaceChildren(free, stack);

  const tracks = new Set<TextTrack>();
  const elements = new Map<CaptionCue, HTMLElement>();
  let rendered: CaptionCue[] = [];
  let sampleCue: CaptionCue | null = null;
  let view: CaptionView = { controlsVisible: false, sample: null };
  let native = false;

  const layout = () => {
    const rect = video.getBoundingClientRect();
    const box = pictureBox(rect.width, rect.height, video.videoWidth, video.videoHeight);
    layer.style.left = `${box.left}px`;
    layer.style.top = `${box.top}px`;
    layer.style.width = `${box.width}px`;
    layer.style.height = `${box.height}px`;
    layer.style.setProperty("--caption-base", `${captionFontSize(box.width)}px`);
    const inset = clamp(box.height * 0.05, 16, 32);
    const restingBottom = rect.top + box.top + box.height - inset;
    const lift = view.controlsVisible
      ? Math.max(0, restingBottom - (controls.getBoundingClientRect().top - CONTROLS_GAP))
      : 0;
    stack.style.bottom = `${inset}px`;
    stack.style.transform = lift ? `translateY(${-lift}px)` : "";
  };

  const activeCues = (): CaptionCue[] => {
    if (native) return [];
    const seen = new Set<string>();
    const cues: CaptionCue[] = [];
    for (const track of Array.from(video.textTracks)) {
      if (!isCaptionTrack(track)) continue;
      if (!tracks.has(track)) {
        tracks.add(track);
        track.addEventListener("cuechange", render);
      }
      if (track.mode !== "hidden") continue;
      for (const cue of Array.from(track.activeCues || []) as unknown as CaptionCue[]) {
        const key = `${cue.startTime}|${cue.endTime}|${cue.text}`;
        if (seen.has(key) || !captionText(cue.text).trim()) continue;
        seen.add(key);
        cues.push(cue);
      }
    }
    cues.sort((left, right) => left.startTime - right.startTime);
    if (cues.length === 0 && view.sample) {
      if (sampleCue?.text !== view.sample) {
        sampleCue = { text: view.sample, startTime: 0, endTime: 0 };
      }
      cues.push(sampleCue);
    }
    return cues;
  };

  function render() {
    const cues = activeCues();
    if (
      cues.length === rendered.length &&
      cues.every((cue, index) => cue === rendered[index])
    )
      return;
    rendered = cues;
    const active = new Set(cues);
    for (const [cue, element] of elements) {
      if (active.has(cue)) continue;
      element.remove();
      elements.delete(cue);
    }
    for (const cue of cues) {
      let element = elements.get(cue);
      if (!element) {
        element = buildCue(cue);
        elements.set(cue, element);
      }
      (element.dataset.placed ? free : stack).append(element);
    }
  }

  const present = (nativePresentation: boolean) => {
    native = nativePresentation;
    for (const track of Array.from(video.textTracks)) {
      if (!isCaptionTrack(track)) continue;
      if (native && track.mode === "hidden") track.mode = "showing";
      else if (!native && track.mode === "showing") track.mode = "hidden";
    }
    render();
  };
  const enterNative = () => present(true);
  const leaveNative = () => present(false);
  const nativeEvents = [
    ["webkitbeginfullscreen", enterNative],
    ["webkitendfullscreen", leaveNative],
    ["enterpictureinpicture", enterNative],
    ["leavepictureinpicture", leaveNative],
  ] as const;

  const observer = new ResizeObserver(layout);
  observer.observe(video);
  observer.observe(controls);
  const trackEvents = ["addtrack", "removetrack", "change"] as const;
  for (const event of trackEvents) video.textTracks.addEventListener(event, render);
  for (const [event, listener] of nativeEvents) video.addEventListener(event, listener);
  video.addEventListener("loadedmetadata", layout);
  video.addEventListener("resize", layout);
  layout();
  render();

  return {
    update(next) {
      view = next;
      layout();
      render();
    },
    destroy() {
      observer.disconnect();
      for (const event of trackEvents) video.textTracks.removeEventListener(event, render);
      for (const [event, listener] of nativeEvents) video.removeEventListener(event, listener);
      video.removeEventListener("loadedmetadata", layout);
      video.removeEventListener("resize", layout);
      for (const track of tracks) track.removeEventListener("cuechange", render);
      layer.replaceChildren();
    },
  };
}
