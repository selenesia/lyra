import { useCallback, useEffect } from "preact/hooks";
import {
  gamesViewSignal,
  watchViewSignal,
  chatViewSignal,
  settingsViewSignal,
  useUiSignal,
} from "../../core/ui/uiSignals.ts";
import { IconCloud } from "../icons";
import { svgIcon } from "../../core/ui/svgIcon";
import { isManagedModalOpen } from "../../core/ui/modal.ts";
import { invokeWindowAction } from "../../core/browser/windowActions.ts";import { isStatic } from "../../core/runtime/hosting.ts";
import {
  preloadWatchCatalog,
  loadCloudSync,
  preloadGamesCatalog,
  loadSettingsPage,
  loadChatPage,
} from "../../app/loaders.ts";

function cloudSyncUsername(): string | null {
  try {
    const user = JSON.parse(localStorage.getItem("auth_user") || "{}");
    return typeof user?.username === "string" && user.username ? user.username : null;
  } catch {
    return null;
  }
}

function openCloudSync(): void {
  void loadCloudSync().then(() => {
    if (!isManagedModalOpen(document.getElementById("cloudsync-modal"))) {
      document.dispatchEvent(new CustomEvent("toggleCloudSyncModal"));
    }
  });
}

function preloadChat(): void {
  void (cloudSyncUsername() ? loadChatPage() : loadCloudSync());
}

export default function TopBar() {
  const gamesView = useUiSignal(gamesViewSignal);
  const watchView = useUiSignal(watchViewSignal);
  const chatView = useUiSignal(chatViewSignal);
  const settingsView = useUiSignal(settingsViewSignal);

  useEffect(() => {
    const username = isStatic ? null : cloudSyncUsername();
    if (username) {
      const statusEl = document.getElementById("auth-status");
      if (statusEl) statusEl.textContent = username;
    }
    const choiIcon = document.getElementById("games-icon");
    if (choiIcon && !choiIcon.innerHTML) {
      choiIcon.innerHTML = svgIcon("IconGamecontroller", { solid: true });
    }
    const watchIcon = document.getElementById("watch-icon");
    if (watchIcon && !watchIcon.innerHTML) {
      watchIcon.innerHTML = svgIcon("IconVideoClip", { size: 22, solid: true });
    }
    const chatIcon = document.getElementById("chat-icon");
    if (chatIcon && !chatIcon.innerHTML) {
      chatIcon.innerHTML = svgIcon("IconChat", { solid: true });
    }
    const settingsIcon = document.getElementById("settings-icon");
    if (settingsIcon && !settingsIcon.innerHTML) {
      settingsIcon.innerHTML = svgIcon("IconSettingsGear4", { solid: true });
    }
  }, []);

  const handleBrandClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    window.hideGameMenu?.();
    window.hideWatchMenu?.();
    window.hideChatPage?.();
    window.hideSettingsPage?.();
  }, []);

  const handleGamesClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleGameMenu");
  }, []);

  const handleWatchClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleWatchMenu");
  }, []);

  const handleChatClick = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      if (!chatView && !cloudSyncUsername()) {
        openCloudSync();
        return;
      }
      invokeWindowAction("toggleChatPage");
    },
    [chatView],
  );

  const handleSettingsClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleSettingsPage");
  }, []);

  return (
    <>
      <div id="top-left-stuff">
        <div
          id="branding-container"
          class="icon-btn"
          onClick={handleBrandClick}
        >
          <span id="brand">lyraaaa</span>
          <div id="oneko"></div>
        </div>
        <a
          href="#"
          id="choi"
          class="icon-btn"
          data-tooltip={gamesView ? "search" : "games"}
          onPointerEnter={preloadGamesCatalog}
          onFocus={preloadGamesCatalog}
          onClick={handleGamesClick}
        >
          <span id="games-icon" />
        </a>
        <a
          href="#"
          id="media-catalog"
          class="icon-btn"
          data-tooltip={watchView ? "search" : "watch"}
          onPointerEnter={preloadWatchCatalog}
          onFocus={preloadWatchCatalog}
          onClick={handleWatchClick}
        >
          <span id="watch-icon" />
        </a>
        {!isStatic && (
          <a
            href="#"
            id="chat-btn"
            class="icon-btn"
            data-tooltip={chatView ? "search" : "chats"}
            onPointerEnter={preloadChat}
            onFocus={preloadChat}
            onClick={handleChatClick}
          >
            <span id="chat-icon" />
          </a>
        )}
      </div>
      <div id="top-right-stuff">
        {!isStatic && <div
          id="auth-container"
          class="text-icon-btn"
          onPointerEnter={() => void loadCloudSync()}
          onFocus={() => void loadCloudSync()}
          onClick={() =>
            document.dispatchEvent(new CustomEvent("toggleCloudSyncModal"))
          }
        >
          <IconCloud solid />
          <span id="auth-status">cloud sync</span>
        </div>}
        <a
          href="#"
          id="settings"
          class="icon-btn"
          data-tooltip={settingsView ? "search" : "settings"}
          onPointerEnter={() => void loadSettingsPage()}
          onFocus={() => void loadSettingsPage()}
          onClick={handleSettingsClick}
        >
          <span id="settings-icon" />
        </a>
      </div>
    </>
  );
}
