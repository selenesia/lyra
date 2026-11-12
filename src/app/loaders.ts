export const loadGamesCatalog = () =>
  import("../components/games/GamesCatalog.tsx");

export const loadWatchCatalog = () =>
  import("../components/watch/WatchCatalog.tsx");

export function preloadGamesCatalog() {
  void loadGamesCatalog().catch(() => {});
  void import("../features/games/games.ts")
    .then(({ fetchGameData }) => fetchGameData())
    .catch(() => {});
}

export function preloadWatchCatalog() {
  void loadWatchCatalog().catch(() => {});
  void import("../features/anime/anime.ts")
    .then(({ fetchAnimeData }) => fetchAnimeData("trending"))
    .catch(() => {});
  void import("../features/watch/titles.ts")
    .then(({ fetchTitleHome }) => fetchTitleHome())
    .catch(() => {});
}

export const loadNewTabModal = () =>
  import("../components/browser/NewTabModal.tsx");

export const loadSettingsPage = () =>
  import("../components/settings/SettingsPage.tsx");

export const loadFallingLeaves = () =>
  import("../components/layout/FallingLeaves.tsx");

export const loadChatPage = () => import("../components/chat/ChatPage.tsx");

export const loadTutorial = () => import("../components/layout/Tutorial.tsx");

export const loadCloudSync = () =>
  Promise.all([
    import("../assets/styles/cloudsync/cloudsync-modal.css"),
    import("../features/cloudsync/cloudsync.ts"),
  ]).then(() => undefined);
