import { render } from "preact";
import Player from "../components/player/Player.tsx";
import { appPath } from "../core/runtime/hosting.ts";
import { parseTitlePlayback } from "../features/watch/watchPlayback.ts";
import { resolveTheme } from "../core/config/settingsOptions.ts";
import { applyTheme } from "../core/ui/theme.ts";
import {
  applyMotionPreference,
  readMotionPreference,
} from "../core/config/advancedSettings.ts";
import "../assets/styles/base/themes.css";
import "../assets/styles/base/motion.css";
import "../assets/styles/watch/episode-selector.css";
import "../assets/styles/player/player.css";
import "../assets/styles/toast/toast.css";
import "../features/ui/toast.ts";

const recoveryUrl = new URL(window.location.href);
if (recoveryUrl.pathname === appPath("/stream/anime") && parseTitlePlayback(recoveryUrl.searchParams)) {
  recoveryUrl.pathname = appPath("/stream/watch");
}
recoveryUrl.searchParams.delete("recovery");
if (recoveryUrl.href !== window.location.href) {
  history.replaceState(history.state, "", recoveryUrl.href);
}

applyTheme(resolveTheme(localStorage.getItem("theme")));

applyMotionPreference(readMotionPreference());

const root = document.getElementById("player-root");
if (root) {
  render(<Player />, root);
}
