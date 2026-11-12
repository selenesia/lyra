import { useEffect, lazy, Suspense, useState } from "preact/compat";
import Sidebar from "../components/browser/Sidebar.tsx";
import NavBar from "../components/browser/NavBar.tsx";
import SearchBar from "../components/browser/SearchBar.tsx";
import Bookmarks from "../components/browser/Bookmarks.tsx";
import Footer from "../components/layout/Footer.tsx";
import LiveNotices from "../components/layout/LiveNotices.tsx";
import TopBar from "../components/browser/TopBar.tsx";
import { tutorialSeen } from "../components/layout/tutorialSeen.ts";
import hachiiUrl from "../assets/images/peaks/hachii.webp";
import konaUrl from "../assets/images/peaks/kona.webp";
import osaUrl from "../assets/images/peaks/osa.webp";
import azuUrl from "../assets/images/peaks/azu.webp";
import {
  loadWatchCatalog,
  loadGamesCatalog,
  loadNewTabModal,
  loadSettingsPage,
  loadChatPage,
  loadFallingLeaves,
  loadTutorial,
} from "./loaders.ts";
import {
  prefersReducedMotion,
  readAdvancedToggle,
} from "../core/config/advancedSettings.ts";

const peakUrls = [hachiiUrl, konaUrl, osaUrl, azuUrl];
const PEAK_INDEX_STORAGE_KEY = "lyra-title-peak-index";

function getRandomPeakIndex(): number {
  const preloadedIndex = Number(document.documentElement.dataset.peakIndex);
  if (
    Number.isInteger(preloadedIndex) &&
    preloadedIndex >= 0 &&
    preloadedIndex < peakUrls.length
  ) {
    return preloadedIndex;
  }

  let previousIndex = -1;
  try {
    const storedIndex = localStorage.getItem(PEAK_INDEX_STORAGE_KEY);
    if (storedIndex !== null) previousIndex = Number(storedIndex);
  } catch {}

  let nextIndex = Math.floor(Math.random() * peakUrls.length);
  if (peakUrls.length > 1 && nextIndex === previousIndex) {
    nextIndex =
      (nextIndex + 1 + Math.floor(Math.random() * (peakUrls.length - 1))) %
      peakUrls.length;
  }

  try {
    localStorage.setItem(PEAK_INDEX_STORAGE_KEY, String(nextIndex));
  } catch {}
  return nextIndex;
}

const GamesCatalog = lazy(loadGamesCatalog);
const WatchCatalog = lazy(loadWatchCatalog);
const NewTabModal = lazy(loadNewTabModal);
const SettingsPage = lazy(loadSettingsPage);
const ChatPage = lazy(loadChatPage);
const FallingLeaves = lazy(loadFallingLeaves);
const Tutorial = lazy(loadTutorial);

const SITE_IN_USE_CLASSES = [
  "browser-view",
  "split-view",
  "is-picking-split",
] as const;

function siteInUse(): boolean {
  const { classList } = document.body;
  return SITE_IN_USE_CLASSES.some((name) => classList.contains(name));
}

function shouldShowLeaves(): boolean {
  return (
    readAdvancedToggle("fallingLeaves") &&
    !prefersReducedMotion() &&
    !siteInUse()
  );
}

export default function App() {
  const [gamesMounted, setGamesMounted] = useState(false);
  const [watchMounted, setWatchMounted] = useState(false);
  const [newTabMounted, setNewTabMounted] = useState(false);
  const [settingsPageMounted, setSettingsPageMounted] = useState(false);
  const [chatMounted, setChatMounted] = useState(false);
  const [leavesMounted, setLeavesMounted] = useState(false);
  const [tutorial, setTutorial] = useState<"unseen" | "replay" | null>(() =>
    tutorialSeen() ? null : "unseen",
  );
  const [peakSrc] = useState(
    () =>
      document.documentElement.dataset.peakSrc ||
      peakUrls[getRandomPeakIndex()],
  );

  useEffect(() => {
    const showGames = () => setGamesMounted(true);
    const showWatch = () => setWatchMounted(true);
    const showNewTab = () => {
      setNewTabMounted(true);
    };
    const showSettingsPage = () => setSettingsPageMounted(true);
    const showChat = () => setChatMounted(true);
    const replayTutorial = () => setTutorial((current) => current ?? "replay");
    const runtimeWindow = window as typeof window & {
      showNewTabModal?: () => void;
    };

    window.showGameMenu = showGames;
    window.toggleGameMenu = showGames;
    window.showWatchMenu = showWatch;
    window.toggleWatchMenu = showWatch;
    runtimeWindow.showNewTabModal = showNewTab;
    window.showSettingsPage = showSettingsPage;
    window.toggleSettingsPage = showSettingsPage;
    window.showChatPage = showChat;
    window.toggleChatPage = showChat;
    document.addEventListener("show-tutorial", replayTutorial);

    return () => {
      document.removeEventListener("show-tutorial", replayTutorial);
      if (window.showGameMenu === showGames) delete window.showGameMenu;
      if (window.toggleGameMenu === showGames) delete window.toggleGameMenu;
      if (window.showWatchMenu === showWatch) delete window.showWatchMenu;
      if (window.toggleWatchMenu === showWatch) delete window.toggleWatchMenu;
      if (runtimeWindow.showNewTabModal === showNewTab) {
        delete runtimeWindow.showNewTabModal;
      }
      if (window.showSettingsPage === showSettingsPage) {
        delete window.showSettingsPage;
      }
      if (window.toggleSettingsPage === showSettingsPage) {
        delete window.toggleSettingsPage;
      }
      if (window.showChatPage === showChat) delete window.showChatPage;
      if (window.toggleChatPage === showChat) delete window.toggleChatPage;
    };
  }, []);

  useEffect(() => {
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;

    const cancelPending = () => {
      if (idleHandle !== undefined) cancelIdleCallback(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      idleHandle = undefined;
      timeoutHandle = undefined;
    };

    let wanted = false;
    const sync = () => {
      const next = shouldShowLeaves();
      if (next === wanted) return;
      wanted = next;
      cancelPending();
      if (!next) {
        setLeavesMounted(false);
        return;
      }
      const mount = () => setLeavesMounted(true);
      if (typeof requestIdleCallback === "function") {
        idleHandle = requestIdleCallback(mount, { timeout: 3000 });
      } else {
        timeoutHandle = window.setTimeout(mount, 1500);
      }
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    sync();
    document.addEventListener("fallingLeavesUpdated", sync);
    document.addEventListener("motionPreferenceUpdated", sync);
    systemMotion.addEventListener("change", sync);
    return () => {
      cancelPending();
      observer.disconnect();
      document.removeEventListener("fallingLeavesUpdated", sync);
      document.removeEventListener("motionPreferenceUpdated", sync);
      systemMotion.removeEventListener("change", sync);
    };
  }, []);

  return (
    <>
      {leavesMounted && (
        <Suspense fallback={null}>
          <FallingLeaves />
        </Suspense>
      )}
      <TopBar />
      <Sidebar />
      <div class="content-area">
        <NavBar />
        <div class="main-container">
          <div class="title">
            <img
              src={peakSrc}
              alt=""
              width="85"
              height="90"
              loading="eager"
              decoding="async"
              fetchpriority="high"
              draggable={false}
            />
          </div>
          <SearchBar />
        </div>
        <Bookmarks />
        {gamesMounted && (
          <Suspense fallback={null}>
            <GamesCatalog openOnMount />
          </Suspense>
        )}
        {watchMounted && (
          <Suspense fallback={null}>
            <WatchCatalog openOnMount />
          </Suspense>
        )}
        {chatMounted && (
          <Suspense fallback={null}>
            <ChatPage openOnMount />
          </Suspense>
        )}
        {settingsPageMounted && (
          <Suspense fallback={null}>
            <SettingsPage openOnMount />
          </Suspense>
        )}
        <div id="iframe-container">
          <div id="iframe-resize-divider"></div>
        </div>
        <Footer />
      </div>
      {newTabMounted && (
        <Suspense fallback={null}>
          <NewTabModal openOnMount />
        </Suspense>
      )}
      <div id="overlay" class="overlay" />
      {tutorial && (
        <Suspense fallback={null}>
          <Tutorial replayOnMount={tutorial === "replay"} />
        </Suspense>
      )}
      <LiveNotices />
    </>
  );
}
