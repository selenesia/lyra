export {};

import type { StreamDiagnostic } from "../core/media/streamDiagnostics.ts";
import type { AnimeIds } from "../features/anime/animeIdentity.ts";

declare global {
  interface Window {
    __lyraStreamDiagnostics?: StreamDiagnostic[];
    showGameMenu?: () => void;
    hideGameMenu?: () => void;
    toggleGameMenu?: () => void;
    showWatchMenu?: () => void;
    hideWatchMenu?: () => void;
    toggleWatchMenu?: () => void;
    playNextEpisode?: (request: {
      title: string;
      year?: number;
      anilistId?: number;
      malId?: number;
      ids?: AnimeIds;
      posterUrl: string;
      episodeCount?: number;
      format?: string;
      episode: number;
      language?: "sub" | "dub";
    }) => void;
    showSettingsPage?: () => void;
    hideSettingsPage?: () => void;
    toggleSettingsPage?: () => void;
    showChatPage?: () => void;
    hideChatPage?: () => void;
    toggleChatPage?: () => void;
  }
}
