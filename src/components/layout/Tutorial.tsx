import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isStatic } from "../../core/runtime/hosting.ts";
import "../../assets/styles/tutorial.css";

const STORAGE_KEY = "lyra-tutorial-seen";
const SPOTLIGHT_PAD = 5;

function spotlightRadius(target: Element) {
  const style = getComputedStyle(target);
  return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map((corner) => corner.split(/\s+/).filter(Boolean)
      .map((part) => (part.endsWith("%") ? part : `calc(${part} + ${SPOTLIGHT_PAD}px)`))
      .join(" "))
    .join(" ");
}
const steps = [
  { title: "a quick look around", target: ".main-container .search-bar .light-inset-bg", text: "use this bar for searches and website addresses. this guide shows you where to find the other main features." },
  { title: "games", target: "#choi", text: 'this controller button opens the games page, to get different games change "game source" in settings. click the button again to return to this current search page.' },
  { title: "watch", target: "#media-catalog", text: "this film button opens the watch page for movies, shows, and anime. also click the button again to return to this current search page." },
  ...(!isStatic ? [{ title: "chat", target: "#chat-btn", text: "this message button opens the community chat rooms. sign in with cloud sync to use. also also click the button again to return to this current search page." }] : []),
  ...(!isStatic ? [{ title: "syncing to the cloudy", target: "#auth-container", text: "this cloud sync button opens your account controls. sign in to privately sync all your app's data like settings, browser, games, and what you're watching across devices!" }] : []),
  { title: "settings", target: "#settings", text: "this gear button opens the settings menu. freely change anything you want across the app." },
  { title: "extensions", target: "#settings", text: 'also included in the same menu, you’ll find an "extensions" tab where you can directly upload, manage, and run chrome extensions directly in the app’s browser. ublock origin comes preinstalled.' },
  { title: "take another look anytime...", target: "#settings", text: "open settings and select tutorial to replay this guide. use back to revisit a step, or click finish to start exploring!!" },
];

export default function Tutorial() {
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== "1"; } catch { return true; }
  });
  const [step, setStep] = useState(0);
  const currentStep = steps[step]!;

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch { }
    setOpen(false);
  };

  useEffect(() => {
    const replay = () => { setStep(0); setOpen(true); };
    document.addEventListener("show-tutorial", replay);
    return () => document.removeEventListener("show-tutorial", replay);
  }, []);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const target = document.querySelector(currentStep.target);
    const panel = card.current;
    const light = spotlight.current;
    if (!target || !panel || !light) return;
    const position = () => {
      const bounds = target.getBoundingClientRect();
      const overlay = dialog.current!;
      const viewport = overlay.getBoundingClientRect();
      if (!viewport.width || !overlay.clientWidth) return;
      const scale = viewport.width / overlay.clientWidth;
      const rect = {
        left: (bounds.left - viewport.left) / scale,
        top: (bounds.top - viewport.top) / scale,
        bottom: (bounds.bottom - viewport.top) / scale,
        width: bounds.width / scale,
        height: bounds.height / scale,
      };
      const width = overlay.clientWidth;
      const height = overlay.clientHeight;
      const gap = 18;
      const inset = 12;
      const below = height - rect.bottom - gap - inset;
      const above = rect.top - gap - inset;
      const placeBelow = below >= panel.scrollHeight || below >= above;
      panel.style.maxHeight = `${Math.max(120, placeBelow ? below : above)}px`;
      const left = Math.max(inset, Math.min(rect.left, width - panel.offsetWidth - inset));
      const top = placeBelow ? rect.bottom + gap : rect.top - gap - panel.offsetHeight;
      panel.style.transform = `translate(${left}px, ${Math.max(inset, Math.min(top, height - panel.offsetHeight - inset))}px)`;
      light.style.transform = `translate(${rect.left - SPOTLIGHT_PAD}px, ${rect.top - SPOTLIGHT_PAD}px)`;
      light.style.width = `${rect.width + SPOTLIGHT_PAD * 2}px`;
      light.style.height = `${rect.height + SPOTLIGHT_PAD * 2}px`;
      light.style.borderRadius = spotlightRadius(target);
    };
    const observer = new ResizeObserver(position);
    observer.observe(dialog.current!);
    observer.observe(target);
    observer.observe(panel);
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, currentStep]);

  return (
    <dialog ref={dialog} class="tutorial" aria-labelledby="tutorial-title" aria-describedby="tutorial-copy"
      onCancel={(event) => { event.preventDefault(); dismiss(); }}>
      <div ref={spotlight} class="tutorial-spotlight" aria-hidden="true" />
      <div ref={card} class="tutorial-card" tabIndex={-1} autoFocus>
      <div class="tutorial-heading">
        <span>{step + 1} / {steps.length}</span>
        <button class="tutorial-secondary" type="button" onClick={dismiss}>skip</button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        <h2 id="tutorial-title">{currentStep.title}</h2>
        <p id="tutorial-copy">{currentStep.text}</p>
      </div>
      <div class="tutorial-actions">
        <button class="tutorial-secondary" type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>back</button>
        <button class="tutorial-next" type="button" onClick={() => step === steps.length - 1 ? dismiss() : setStep(step + 1)}>
          {step === steps.length - 1 ? "finish" : "next"}
        </button>
      </div>
      </div>
    </dialog>
  );
}
