import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isStatic } from "../../core/runtime/hosting.ts";
import { showHomeView } from "../../state/store.ts";
import { markTutorialSeen, tutorialSeen, type TutorialGuide } from "./tutorialSeen.ts";
import "../../assets/styles/tutorial.css";

const SPOTLIGHT_PAD = 5;

function spotlightRadius(target: Element) {
  const style = getComputedStyle(target);
  return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map((corner) => corner.split(/\s+/).filter(Boolean)
      .map((part) => (part.endsWith("%") ? part : `calc(${part} + ${SPOTLIGHT_PAD}px)`))
      .join(" "))
    .join(" ");
}
const homeSteps = [
  { title: "a quick look around", target: ".main-container .search-bar .light-inset-bg", text: "use this bar for searches and website addresses. this guide shows you where to find the other main features." },
  { title: "games", target: "#choi", text: 'this controller button opens the games page, to get different games change "game source" in settings. click the button again to return to the current search page.' },
  { title: "watch", target: "#media-catalog", text: "this film button opens the watch page for movies, shows, and anime. also click the button again to return to the current search page." },
  ...(!isStatic ? [{ title: "chat", target: "#chat-btn", text: "this message button opens the community chat rooms. sign in with cloud sync to use. also also click the button again to return to the current search page." }] : []),
  ...(!isStatic ? [{ title: "syncing to the cloudy", target: "#auth-container", text: "this cloud sync button opens your account controls. sign in to privately sync all your app's data like settings, browser, games, and what you're watching across devices!" }] : []),
  { title: "settings", target: "#settings", text: "this gear button opens the settings menu. freely change anything you want across the app. also also also click the button again to return to the current search page." },
  { title: "extensions", target: "#settings", text: 'also included in the same menu, you’ll find an "extensions" tab where you can directly upload, manage, and run chrome extensions directly in the app’s browser. ublock origin comes preinstalled.' },
  { title: "take another look anytime...", target: "#settings", text: "open settings and select tutorial to replay this guide. use back to revisit a step, or click finish to start exploring!!" },
];

const chatSteps = [
  { title: "your chats", target: "#chat-page .chat-channels", text: "switch between channels, dms, and group chats here. badges show unread messages." },
  { title: "direct messages and groups", target: "#chat-page .chat-category-add", text: "click the + icon. pick one person for a dm or several for a group." },
  { title: "sending messages", target: "#chat-page .chat-bar", text: "enter sends, shift + enter adds a line. click the + for images, audio, or video and @ for mentions." },
  { title: "replies and reactions", target: "#chat-page .chat-feed", text: "hover or tap a message to reply, react, or edit your own. click an avatar to view a profile." },
  { title: "watch together", target: "#chat-page .chat-bar", text: "type /watch and a title, then pick a result. others can join from your invitation." },
];

export default function Tutorial({ replayOnMount = false, guide = "home" }: { replayOnMount?: boolean; guide?: TutorialGuide }) {
  const steps = guide === "chat" ? chatSteps : homeSteps;
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => !tutorialSeen(guide));
  const [step, setStep] = useState(0);
  const currentStep = steps[step]!;

  const dismiss = () => {
    markTutorialSeen(guide);
    setOpen(false);
  };

  useEffect(() => {
    if (guide !== "home") return;
    const replay = () => {
      window.hideGameMenu?.();
      window.hideWatchMenu?.();
      window.hideChatPage?.();
      window.hideSettingsPage?.();
      showHomeView();
      setStep(0);
      setOpen(true);
    };
    if (replayOnMount) replay();
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
      panel.style.maxWidth = `${Math.max(0, width - inset * 2)}px`;
      panel.style.maxHeight = `${Math.max(0, height - inset * 2)}px`;
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const right = rect.left + rect.width;
      let left = rect.left;
      let top = rect.bottom + gap;
      if (top + panelHeight <= height - inset) {
        top = rect.bottom + gap;
      } else if (rect.top - gap - panelHeight >= inset) {
        top = rect.top - gap - panelHeight;
      } else if (right + gap + panelWidth <= width - inset) {
        left = right + gap;
        top = rect.top;
      } else if (rect.left - gap - panelWidth >= inset) {
        left = rect.left - gap - panelWidth;
        top = rect.top;
      } else {
        left = (width - panelWidth) / 2;
        top = (height - panelHeight) / 2;
      }
      left = Math.max(inset, Math.min(left, width - panelWidth - inset));
      top = Math.max(inset, Math.min(top, height - panelHeight - inset));
      panel.style.transform = `translate(${left}px, ${top}px)`;
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
    <dialog ref={dialog} class="tutorial" aria-labelledby={`tutorial-${guide}-title`} aria-describedby={`tutorial-${guide}-copy`}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}>
      <div ref={spotlight} class="tutorial-spotlight" aria-hidden="true" />
      <div ref={card} class="tutorial-card" tabIndex={-1} autoFocus>
      <div class="tutorial-heading">
        <span>{step + 1} / {steps.length}</span>
        <button class="tutorial-secondary" type="button" onClick={dismiss}>skip</button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        <h2 id={`tutorial-${guide}-title`}>{currentStep.title}</h2>
        <p id={`tutorial-${guide}-copy`}>{currentStep.text}</p>
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
