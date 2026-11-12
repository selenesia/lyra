import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import {
  getGameDisplayLabel,
  searchGames,
  type GameEntry,
} from "../../features/games/games.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  hostFromUrl,
  recordGameMetric,
} from "../../core/media/gameDiagnostics.ts";
import { gamesViewSignal } from "../../core/ui/uiSignals.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { app } from "../../core/runtime/app.ts";
import { useGameCatalog } from "../../features/games/useGameCatalog.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import CatalogView from "../catalog/CatalogView.tsx";
import "../../assets/styles/games/games.css";

const SVG_GAMEPAD = svgIcon("IconGamecontroller", { solid: true });
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");
function gameCard(game: GameEntry) {
  return { title: game.name, cover: game.coverUrl };
}

export default function GamesCatalog({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [query, setQuery] = useState("");

  const { visible, searchBarRef, show, hide, toggle } = useMenuView({
    bodyClass: "games-view",
    signal: gamesViewSignal,
    iconId: "games-icon",
    inactiveIcon: SVG_GAMEPAD,
    activeIcon: SVG_SEARCH,
    openedStorageKey: "lyraUserOpenedGameMenu",
    hideOtherViews: () => {
      window.hideWatchMenu?.();
      window.hideChatPage?.();
      window.hideSettingsPage?.();
    },
    showOnMount: openOnMount,
  });

  const { games: allGames, loaded, error } = useGameCatalog(visible);

  useEffect(() => {
    const resetQuery = () => setQuery("");
    document.addEventListener("gameSourceUpdated", resetQuery);
    return () => document.removeEventListener("gameSourceUpdated", resetQuery);
  }, []);

  useEffect(() => {
    window.showGameMenu = show;
    window.hideGameMenu = hide;
    window.toggleGameMenu = toggle;

    app().getGameDisplayLabel = getGameDisplayLabel;
  }, [show, hide, toggle]);

  const handlePlay = useCallback(
    (game: GameEntry) => {
      const gameHost = hostFromUrl(game.gameUrl);
      const launchMetric = {
        stage: "launch" as const,
        source: game.sourceKey,
        status: "started" as const,
        durationMs: 0,
        ...(gameHost ? { urlHost: gameHost } : {}),
      };
      recordGameMetric(launchMetric);

      if (game.isExternal) {
        const popup = window.open(
          game.gameUrl,
          "_blank",
          "noopener,noreferrer",
        );
        if (!popup) {
          recordGameMetric({
            ...launchMetric,
            status: "error",
            errorKind: "popup-blocked",
          });
        }
      } else if (app().handleSearch) {
        hide();
        try {
          const launchResult = app().handleSearch?.(
            game.gameUrl,
            game.name,
            game.coverUrl,
          );
          void Promise.resolve(launchResult).catch(() => {
            recordGameMetric({
              ...launchMetric,
              status: "error",
              errorKind: "navigation-start-failed",
            });
          });
        } catch {
          recordGameMetric({
            ...launchMetric,
            status: "error",
            errorKind: "navigation-start-failed",
          });
        }
      }
    },
    [hide],
  );

  const filteredGames = useMemo(() => {
    return searchGames(allGames, query);
  }, [allGames, query]);

  const placeholder = loaded
    ? `search through ${allGames.length} games... ◝(ᵔᗜᵔ)◜`
    : "fetching games...";

  return (
    <CatalogView
      id="games-page"
      className="games-page"
      inputId="catalogSearchInput"
      visible={visible}
      searchBarRef={searchBarRef}
      query={query}
      placeholder={placeholder}
      onQueryChange={setQuery}
      showSkeleton={!loaded}
      items={filteredGames}
      getCard={gameCard}
      onSelect={handlePlay}
      emptyMessage={
        loaded && filteredGames.length === 0
          ? error || negativeMessage("zero matching games were found")
          : null
      }
    />
  );
}
