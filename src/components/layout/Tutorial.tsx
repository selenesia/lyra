import type { ComponentChildren } from "preact";
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
const homeSteps: TutorialStep[] = [
  { title: "search or open a site", target: ".main-container .search-bar .light-inset-bg", text: "type a search or paste a website address, then press enter." },
  { title: "save a shortcut", target: "#bookmarks-edit-toggle", text: "choose edit to add, rename, or remove bookmarks on your home page." },
  { title: "play games", target: "#choi", text: "browse the games catalog. for a different selection, change game source in settings." },
  { title: "find something to watch", target: "#media-catalog", text: "browse movies, shows, and anime, or pick up where you left off." },
  ...(!isStatic ? [
    { title: "join the chat", target: "#chat-btn", text: "sign in with cloud sync to join community channels and message friends." },
    { title: "sync across devices", target: "#auth-container", text: "use the same cloud sync account to keep your settings, bookmarks, and watch progress across devices." },
  ] : []),
  { title: "make lyra yours", target: "#settings", text: "change your theme, playback settings, or extensions here. choose tutorial in settings to replay this guide." },
];

export type TutorialProfileStage = "view" | "edit";

interface TutorialStep {
  title: string;
  target: string;
  text: string;
  profileStage?: TutorialProfileStage;
}

const profileShortcutStep: TutorialStep = {
  title: "edit your profile",
  target: "#chat-page .chat-self-card",
  text: "click your name to open your profile, then choose edit profile.",
};

const chatSteps: TutorialStep[] = [
  { title: "your chats", target: "#chat-page .chat-channels", text: "switch between channels, dms, and groups. badges show unread messages." },
  { title: "start a dm or group", target: "#chat-page .chat-category-add", text: "pick one person for a dm or several for a group." },
  profileShortcutStep,
  { title: "make it yours", target: "#chat-profile-modal .episode-season-tabs", profileStage: "edit", text: "try an avatar decoration, profile effect, nameplate, or frame. preview your picks, then hit save." },
  { title: "attach a file", target: "#chat-page .chat-attach-button", text: "tap + to attach a photo, video, or audio file." },
  { title: "watch together", target: "#chatInput", text: "type /watch and a title, then pick a result to invite the chat." },
  { title: "send a gif", target: "#chat-page .chat-gif-button", text: "tap gif or type /gif to search. pick a gif, then press enter to send." },
];

const narrowProfileStep: TutorialStep = {
  title: "edit your profile",
  target: "#chat-profile-modal .chat-card-edit",
  profileStage: "view",
  text: "tap your avatar on a message to open your profile, then choose edit profile.",
};

interface TutorialProps {
  replayOnMount?: boolean;
  guide?: TutorialGuide;
  renderProfile?: (stage: TutorialProfileStage) => ComponentChildren;
}

export default function Tutorial({ replayOnMount = false, guide = "home", renderProfile }: TutorialProps) {
  const steps = guide === "chat" ? chatSteps : homeSteps;
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => !tutorialSeen(guide));
  const [step, setStep] = useState(0);
  const [narrowChat, setNarrowChat] = useState(false);
  const stepDetails = steps[step]!;
  const currentStep = narrowChat && stepDetails === profileShortcutStep ? narrowProfileStep : stepDetails;

  useLayoutEffect(() => {
    if (!open || guide !== "chat") return;
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrowChat(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [open, guide]);

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

  useLayoutEffect(() => {
    const modal = dialog.current;
    if (!open || !modal) return;
    modal.showModal();
    return () => modal.close();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const target = document.querySelector(currentStep.target);
    const overlay = dialog.current;
    const panel = card.current;
    const light = spotlight.current;
    if (!overlay || !panel || !light) return;
    if (guide === "chat") target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const position = () => {
      const bounds = target?.getBoundingClientRect();
      const viewport = overlay.getBoundingClientRect();
      if (!viewport.width || !overlay.clientWidth) return;
      const scale = viewport.width / overlay.clientWidth;
      const rect = bounds?.width && bounds.height ? {
        left: (bounds.left - viewport.left) / scale,
        top: (bounds.top - viewport.top) / scale,
        bottom: (bounds.bottom - viewport.top) / scale,
        width: bounds.width / scale,
        height: bounds.height / scale,
      } : null;
      const width = overlay.clientWidth;
      const height = overlay.clientHeight;
      const gap = 18;
      const inset = 12;
      panel.style.maxWidth = `${Math.max(0, width - inset * 2)}px`;
      panel.style.maxHeight = `${Math.max(0, height - inset * 2)}px`;
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      if (!rect || !target) {
        light.style.width = "0";
        light.style.height = "0";
        panel.style.transform = `translate(${(width - panelWidth) / 2}px, ${(height - panelHeight) / 2}px)`;
        return;
      }
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
    observer.observe(overlay);
    if (target) observer.observe(target);
    observer.observe(panel);
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, currentStep, guide]);

  return (
    <>
      {open && currentStep.profileStage && renderProfile?.(currentStep.profileStage)}
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
    </>
  );
}
