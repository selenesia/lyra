import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  IconBook,
  IconBubbleText,
  IconChevronBottom,
  IconGhost,
  IconHammer2,
  IconMagnifyingGlass2,
  IconPaintBrush,
  IconPuzzle,
  IconSettingsSliderHor,
  IconVideoClip,
} from "../icons";
import type { IconProps } from "../icons/IconBase";
import EditableField from "../EditableField.tsx";
import { useMenuView } from "../../hooks/useMenuView.ts";
import { useSlidingPill } from "../../hooks/useSlidingPill.ts";
import { settingsViewSignal } from "../../core/ui/uiSignals.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { toast } from "../../core/ui/toast.ts";
import { switchTheme } from "../../core/ui/theme.ts";
import { SEARCH_ENGINE_OPTIONS } from "../../core/config/config.ts";
import {
  ADVANCED_SETTING_KEYS,
  MOTION_OPTIONS,
  applyMotionPreference,
  readAdvancedToggle,
  readMotionPreference,
  type MotionPreference,
} from "../../core/config/advancedSettings.ts";
import {
  DEFAULT_SETTINGS,
  GAME_SOURCE_OPTIONS,
  LINK_CLOAKING_OPTIONS,
  SITE_CLOAKING_OPTIONS,
  THEME_OPTIONS,
  TRANSPORT_OPTIONS,
  resolveGameSource,
  resolveTheme,
} from "../../core/config/settingsOptions.ts";
import {
  warmExtensionRuntime,
  warmProxyRuntime,
} from "../../core/proxy/proxyRuntime.ts";
import { getRivet } from "../../core/proxy/rivetBridge.ts";
import { NEGATIVE, negativeMessage } from "../../core/runtime/messages.ts";
import { fetchServiceMetadata } from "../../core/runtime/serviceMetadata.ts";
import { HISTORY_STORAGE_KEY } from "../../core/browser/history.ts";
import {
  ANIME_LANGUAGE_KEY,
  ANIME_LANGUAGE_OPTIONS,
  ANIME_QUALITY_KEY,
  ANIME_QUALITY_OPTIONS,
  ANIME_SETTING_KEYS,
  ANIME_SUBTITLE_KEY,
  ANIME_SUBTITLE_OPTIONS,
  readAnimeLanguage,
  readAnimeQuality,
  readAnimeSetting,
  readAnimeSubtitles,
} from "../../core/media/animeSettings.ts";
import {
  WATCH_LANGUAGE_KEY,
  WATCH_LANGUAGE_OPTIONS,
  readWatchLanguage,
  watchLanguageName,
} from "../../features/watch/watchPlayback.ts";
import {
  CAPTION_STYLE_NAMES,
  CAPTION_STYLE_OPTIONS,
  DEFAULT_CAPTION_STYLE,
  captionStyleVariables,
  isDefaultCaptionStyle,
  readCaptionStyle,
  saveCaptionStyle,
  type CaptionStyle,
  type CaptionStyleName,
} from "../player/captionStyle.ts";
import type { InstalledExtensionSummary } from "../../../packages/rivet/src/index";
import "../../assets/styles/catalog/catalog.css";
import "../../assets/styles/settings/settings-page.css";

const SVG_SETTINGS = svgIcon("IconSettingsGear4", { solid: true });
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");

type SectionId =
  | "preferences"
  | "appearance"
  | "watch"
  | "subtitles"
  | "cloaking"
  | "extensions"
  | "advanced";

const SECTIONS: readonly {
  id: SectionId;
  label: string;
  icon: (props: IconProps) => ComponentChildren;
}[] = [
  { id: "preferences", label: "preferences", icon: IconSettingsSliderHor },
  { id: "appearance", label: "appearance", icon: IconPaintBrush },
  { id: "watch", label: "watch", icon: IconVideoClip },
  { id: "subtitles", label: "subtitles", icon: IconBubbleText },
  { id: "cloaking", label: "tab identity", icon: IconGhost },
  { id: "extensions", label: "extensions", icon: IconPuzzle },
  { id: "advanced", label: "advanced", icon: IconHammer2 },
];

interface SettingField {
  section: SectionId;
  key: string;
  label: string;
  description: string;
  options?: readonly string[];
  format?: (value: string) => string;
}

const FIELDS: readonly SettingField[] = [
  {
    section: "preferences",
    key: "searchEngine",
    label: "search engine",
    description: "the engine that is used for your search queries.",
    options: SEARCH_ENGINE_OPTIONS,
  },
  {
    section: "preferences",
    key: "gameSource",
    label: "game source",
    description: "where all the games are fetched from.",
    options: GAME_SOURCE_OPTIONS,
  },
  {
    section: "preferences",
    key: "preventClosing",
    label: "prevent closing",
    description: "prevent the tab from being closed.",
  },
  {
    section: "appearance",
    key: "theme",
    label: "theme",
    description: "change the look and feel of lyra.",
    options: THEME_OPTIONS,
  },
  {
    section: "appearance",
    key: ADVANCED_SETTING_KEYS.motion,
    label: "motion effects",
    description:
      "follow the device setting, reduce motion, or allow full effects.",
    options: MOTION_OPTIONS,
  },
  {
    section: "appearance",
    key: ADVANCED_SETTING_KEYS.fallingLeaves,
    label: "falling leaves",
    description: "autumn leaves falling across your screen.",
  },
  {
    section: "watch",
    key: WATCH_LANGUAGE_KEY,
    label: "movie and show audio",
    description: "default audio language for movies and shows.",
    options: WATCH_LANGUAGE_OPTIONS,
    format: watchLanguageName,
  },
  {
    section: "watch",
    key: ANIME_LANGUAGE_KEY,
    label: "anime audio",
    description: "default audio for anime.",
    options: ANIME_LANGUAGE_OPTIONS,
  },
  {
    section: "watch",
    key: ANIME_QUALITY_KEY,
    label: "preferred quality",
    description: "default quality; auto adapts to your connection.",
    options: ANIME_QUALITY_OPTIONS,
    format: (quality) => (quality === "2160p" ? "4k" : quality),
  },
  {
    section: "watch",
    key: ANIME_SUBTITLE_KEY,
    label: "preferred subtitles",
    description: "default subtitles; auto follows the audio.",
    options: ANIME_SUBTITLE_OPTIONS,
  },
  {
    section: "watch",
    key: ANIME_SETTING_KEYS.autoSkipIntroOutro,
    label: "auto skip intro and outro",
    description: "auto skip intro and outro, if available.",
  },
  {
    section: "watch",
    key: ANIME_SETTING_KEYS.autoPlayNextEpisode,
    label: "auto play next episode",
    description: "automatically start the next episode.",
  },
  {
    section: "cloaking",
    key: "siteCloaking",
    label: "title and icon",
    description: "choose the title and icon shown for this tab.",
    options: SITE_CLOAKING_OPTIONS,
  },
  {
    section: "cloaking",
    key: "linkCloaking",
    label: "address display",
    description: "choose how the site appears in the address bar.",
    options: LINK_CLOAKING_OPTIONS,
  },
  {
    section: "cloaking",
    key: "focusCloaking",
    label: "inactive tab identity",
    description:
      "apply the selected title and icon only while this tab is unfocused.",
  },
  {
    section: "advanced",
    key: "transport",
    label: "other transport",
    description:
      "our transport handles http requests; this handles websockets and fallback traffic.",
    options: TRANSPORT_OPTIONS,
  },
  {
    section: "advanced",
    key: ADVANCED_SETTING_KEYS.preloadProxy,
    label: "preload engine",
    description: "load the browser engine early so the first page opens faster.",
  },
  {
    section: "advanced",
    key: ADVANCED_SETTING_KEYS.saveHistory,
    label: "save browsing history",
    description:
      "keep visited urls between launches; turning this off removes saved history.",
  },
];

const SUBTITLE_KEYWORDS =
  "subtitle style subtitles captions size color background edge preview";
const EXTENSION_KEYWORDS = "extensions install chrome extension upload";
const SUBTITLE_SAMPLE = "this is how your subtitles look";

type SettingValue = string | boolean;

function readSettingValues(): Record<string, SettingValue> {
  const siteCloaking =
    localStorage.getItem("siteCloaking") || DEFAULT_SETTINGS.siteCloaking;
  return {
    searchEngine:
      localStorage.getItem("searchEngine") || DEFAULT_SETTINGS.searchEngine,
    gameSource: resolveGameSource(localStorage.getItem("gameSource")),
    preventClosing: localStorage.getItem("preventClosing") !== "false",
    theme: resolveTheme(localStorage.getItem("theme")),
    [ADVANCED_SETTING_KEYS.motion]: readMotionPreference(),
    [ADVANCED_SETTING_KEYS.fallingLeaves]: readAdvancedToggle("fallingLeaves"),
    [WATCH_LANGUAGE_KEY]: readWatchLanguage(),
    [ANIME_LANGUAGE_KEY]: readAnimeLanguage(),
    [ANIME_QUALITY_KEY]: readAnimeQuality(),
    [ANIME_SUBTITLE_KEY]: readAnimeSubtitles(),
    [ANIME_SETTING_KEYS.autoSkipIntroOutro]:
      readAnimeSetting("autoSkipIntroOutro"),
    [ANIME_SETTING_KEYS.autoPlayNextEpisode]: readAnimeSetting(
      "autoPlayNextEpisode",
    ),
    siteCloaking:
      siteCloaking === "default" ? DEFAULT_SETTINGS.siteCloaking : siteCloaking,
    linkCloaking:
      localStorage.getItem("linkCloaking") || DEFAULT_SETTINGS.linkCloaking,
    focusCloaking: localStorage.getItem("focusCloaking") !== "false",
    transport: localStorage.getItem("transport") || DEFAULT_SETTINGS.transport,
    [ADVANCED_SETTING_KEYS.preloadProxy]: readAdvancedToggle("preloadProxy"),
    [ADVANCED_SETTING_KEYS.saveHistory]: readAdvancedToggle("saveHistory"),
  };
}

function announce(name: string, detail?: unknown): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function applySetting(key: string, value: SettingValue): void {
  switch (key) {
    case "theme":
      switchTheme(resolveTheme(String(value)));
      break;
    case "gameSource":
      announce("gameSourceUpdated", value);
      break;
    case "transport":
      announce("newTransport", value);
      break;
    case "siteCloaking":
      announce("siteCloakingUpdated", value);
      break;
    case "linkCloaking":
      announce("linkCloakingUpdated", {
        linkCloaking: value,
        siteCloaking:
          localStorage.getItem("siteCloaking") || DEFAULT_SETTINGS.siteCloaking,
      });
      break;
    case "focusCloaking":
      announce("focusCloakingUpdated", value);
      break;
    case ANIME_LANGUAGE_KEY:
      localStorage.removeItem("lyra-anime-audio");
      announce("animeSettingUpdated", { key, value });
      break;
    case ANIME_SUBTITLE_KEY:
      localStorage.removeItem("lyra-anime-subtitle");
      announce("animeSettingUpdated", { key, value });
      break;
    case WATCH_LANGUAGE_KEY:
    case ANIME_QUALITY_KEY:
    case ANIME_SETTING_KEYS.autoPlayNextEpisode:
    case ANIME_SETTING_KEYS.autoSkipIntroOutro:
      announce("animeSettingUpdated", { key, value });
      break;
    case ADVANCED_SETTING_KEYS.motion:
      applyMotionPreference(value as MotionPreference);
      announce("motionPreferenceUpdated");
      break;
    case ADVANCED_SETTING_KEYS.saveHistory:
      if (!value) localStorage.removeItem(HISTORY_STORAGE_KEY);
      break;
    case ADVANCED_SETTING_KEYS.preloadProxy:
      if (value) warmProxyRuntime();
      break;
    case ADVANCED_SETTING_KEYS.fallingLeaves:
      announce("fallingLeavesUpdated");
      break;
  }
}

function matchesQuery(query: string, ...texts: string[]): boolean {
  return !query || texts.some((text) => text.includes(query));
}

interface SettingSelectProps {
  value: string;
  options: readonly string[];
  format?: ((value: string) => string) | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
}

function SettingSelect({
  value,
  options,
  format,
  open,
  onOpen,
  onClose,
  onChange,
}: SettingSelectProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open, onClose]);

  return (
    <div class={`settings-page-select${open ? " is-open" : ""}`} ref={ref}>
      <button
        type="button"
        class="settings-page-select-value"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={open ? onClose : onOpen}
      >
        <span>{format ? format(value) : value}</span>
        <IconChevronBottom size={16} class="settings-page-select-chevron" />
      </button>
      <div class="settings-page-select-options" role="listbox" aria-hidden={!open}>
        {options
          .filter((option) => option !== value)
          .map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              tabIndex={open ? 0 : -1}
              key={option}
              onClick={() => {
                onChange(option);
                onClose();
              }}
            >
              {format ? format(option) : option}
            </button>
          ))}
      </div>
    </div>
  );
}

function SettingItem({
  label,
  description,
  wide = false,
  children,
}: {
  label: string;
  description: string;
  wide?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class={`settings-page-item${wide ? " is-wide" : ""}`}>
      <h3>{label}</h3>
      <p>{description}</p>
      <div class="settings-page-control">{children}</div>
    </div>
  );
}

function SubtitleStyleEditor() {
  const [style, setStyle] = useState(readCaptionStyle);

  const choose = (name: CaptionStyleName, value: string) => {
    setStyle((current) => {
      const next = { ...current, [name]: value } as CaptionStyle;
      saveCaptionStyle(next);
      return next;
    });
  };

  const reset = () => {
    saveCaptionStyle(DEFAULT_CAPTION_STYLE);
    setStyle({ ...DEFAULT_CAPTION_STYLE });
  };

  return (
    <div class="settings-page-subtitles">
      <div class="settings-page-subtitle-rows">
        {CAPTION_STYLE_NAMES.map((name) => (
          <div class="settings-page-subtitle-row" key={name}>
            <span id={`settings-subtitle-${name}`}>{name}</span>
            <div
              class="settings-page-choices"
              role="radiogroup"
              aria-labelledby={`settings-subtitle-${name}`}
            >
              {CAPTION_STYLE_OPTIONS[name].map((value) => (
                <button
                  type="button"
                  role="radio"
                  key={value}
                  aria-checked={style[name] === value}
                  class={`settings-page-button${style[name] === value ? " is-primary" : ""}`}
                  onClick={() => choose(name, value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          class="settings-page-button"
          disabled={isDefaultCaptionStyle(style)}
          onClick={reset}
        >
          reset to default
        </button>
      </div>
      <div
        class="settings-page-subtitle-preview"
        style={captionStyleVariables(style)}
        aria-hidden="true"
      >
        <span>{SUBTITLE_SAMPLE}</span>
      </div>
    </div>
  );
}

function ExtensionManager({ active }: { active: boolean }) {
  const [extensions, setExtensions] = useState<InstalledExtensionSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active) return;
    warmExtensionRuntime();
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      const rivet = getRivet();
      if (!rivet) return;
      setExtensions(rivet.getInstalledExtensions());
      unsubscribe ??= rivet.onChange(refresh);
    };
    refresh();
    window.addEventListener("rivet-ready", refresh);
    return () => {
      window.removeEventListener("rivet-ready", refresh);
      unsubscribe?.();
    };
  }, [active]);

  const install = async (file: File) => {
    const rivet = getRivet();
    if (!rivet) {
      toast.error("rivet is still connecting");
      return;
    }
    setBusy(true);
    try {
      await rivet.installExtension(await file.arrayBuffer(), file.name);
      toast.success("extension installed");
      setExtensions(rivet.getInstalledExtensions());
    } catch (error) {
      console.error("extension install failed:", error, NEGATIVE);
      toast.error("extension install failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings-page-extensions">
      <label class="settings-page-button is-primary">
        {busy ? "working..." : "upload extension"}
        <input
          type="file"
          accept=".zip,.crx,application/zip"
          disabled={busy}
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (file) void install(file);
            input.value = "";
          }}
        />
      </label>
      {extensions.length === 0 ? (
        <p>no extensions installed.</p>
      ) : (
        extensions.map((extension) => (
          <div class="settings-page-extension" key={extension.id}>
            {extension.iconUrl ? <img src={extension.iconUrl} alt="" /> : null}
            <div class="settings-page-extension-copy">
              <h3>{extension.name}</h3>
              <p>
                {extension.version || "unknown version"} · {extension.id}
              </p>
            </div>
            <button
              type="button"
              class="settings-page-button"
              onClick={() =>
                void getRivet()?.setExtensionEnabled(
                  extension.id,
                  !extension.enabled,
                )
              }
            >
              {extension.enabled ? "disable" : "enable"}
            </button>
            <button
              type="button"
              class="settings-page-button"
              onClick={() => void getRivet()?.uninstallExtension(extension.id)}
            >
              uninstall
            </button>
          </div>
        ))
      )}
    </div>
  );
}

export default function SettingsPage({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [activeSection, setActiveSection] = useState<SectionId>("preferences");
  const [query, setQuery] = useState("");
  const [values, setValues] = useState(readSettingValues);
  const [openSelect, setOpenSelect] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState("");
  const closeSelect = useCallback(() => setOpenSelect(null), []);

  const { visible, searchBarRef, show, hide, toggle } = useMenuView({
    bodyClass: "settings-view",
    signal: settingsViewSignal,
    iconId: "settings-icon",
    inactiveIcon: SVG_SETTINGS,
    activeIcon: SVG_SEARCH,
    hideOtherViews: () => {
      window.hideGameMenu?.();
      window.hideWatchMenu?.();
      window.hideChatPage?.();
    },
    showOnMount: openOnMount,
  });

  const search = query.trim().toLowerCase();
  const setNavTrack = useSlidingPill(
    ".settings-page-tab.active",
    `${search ? "" : activeSection}:${visible}`,
  );

  useEffect(() => {
    window.showSettingsPage = show;
    window.hideSettingsPage = hide;
    window.toggleSettingsPage = toggle;
  }, [show, hide, toggle]);

  useEffect(() => {
    if (visible) setValues(readSettingValues());
    else setOpenSelect(null);
  }, [visible]);

  useEffect(() => {
    void fetchServiceMetadata().then((serviceMetadata) => {
      if (serviceMetadata && typeof serviceMetadata.version === "string") {
        const build =
          typeof serviceMetadata.build === "string"
            ? `~${serviceMetadata.build}`
            : "";
        setVersionInfo(`v${serviceMetadata.version}${build}`);
      }
    });
  }, []);

  const changeSetting = (key: string, value: SettingValue) => {
    setValues((current) => ({ ...current, [key]: value }));
    localStorage.setItem(key, String(value));
    toast.success("settings saved");
    applySetting(key, value);
  };

  const sections = useMemo(
    () =>
      SECTIONS.filter(
        (section) => !!search || section.id === activeSection,
      )
        .map((section) => ({
          ...section,
          fields: FIELDS.filter(
            (field) =>
              field.section === section.id &&
              matchesQuery(search, field.label, field.description),
          ),
          custom:
            (section.id === "subtitles" &&
              matchesQuery(search, SUBTITLE_KEYWORDS)) ||
            (section.id === "extensions" &&
              matchesQuery(search, EXTENSION_KEYWORDS)),
        }))
        .filter((section) => section.fields.length > 0 || section.custom),
    [search, activeSection],
  );
  const extensionsShown = sections.some(
    (section) => section.id === "extensions",
  );

  const opened = useRef(false);
  if (visible) opened.current = true;
  if (!opened.current) return null;

  return (
    <section
      id="settings-page"
      class={`settings-page${visible ? " is-visible" : ""}`}
      aria-hidden={!visible}
    >
      <div class="catalog-topbar">
        <div class="search-bar catalog-search-bar" ref={searchBarRef}>
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <IconMagnifyingGlass2 class="catalog-search-icon" />
          <EditableField
            id="settingsSearchInput"
            label="search settings... ◝(ᵔᗜᵔ)◜"
            placeholder="search settings... ◝(ᵔᗜᵔ)◜"
            value={query}
            onChange={setQuery}
          />
        </div>
      </div>

      <div class="settings-page-body">
        <nav class="settings-page-nav" aria-label="settings sections">
          <p class="settings-page-heading">settings</p>
          <div class="settings-page-tabs" ref={setNavTrack}>
            <span class="settings-page-tab-pill" aria-hidden="true" />
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                class={`settings-page-tab${!search && activeSection === id ? " active" : ""}`}
                onClick={() => {
                  setQuery("");
                  setActiveSection(id);
                }}
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
          <div class="settings-page-divider" role="separator" />
          <p class="settings-page-heading">more</p>
          <button
            type="button"
            class="settings-page-tab"
            onClick={() => {
              hide();
              document.dispatchEvent(new Event("show-tutorial"));
            }}
          >
            <IconBook />
            tutorial
          </button>
          <div class="settings-page-about">
            <span>version</span>
            <strong>{versionInfo || "≽^•⩊•^≼"}</strong>
          </div>
        </nav>

        <div class="settings-page-main">
          {sections.length === 0 && (
            <p class="no-results">
              {negativeMessage("zero matching settings were found")}
            </p>
          )}
          {sections.map((section) => (
            <div class="settings-page-section" key={section.id}>
              {search && <h2>{section.label}</h2>}
              <div class="settings-page-grid">
                {section.fields.map((field) => {
                  const value = values[field.key];
                  return (
                    <SettingItem
                      key={field.key}
                      label={field.label}
                      description={field.description}
                    >
                      {field.options ? (
                        <SettingSelect
                          value={String(value)}
                          options={field.options}
                          format={field.format}
                          open={openSelect === field.key}
                          onOpen={() => setOpenSelect(field.key)}
                          onClose={closeSelect}
                          onChange={(next) => changeSetting(field.key, next)}
                        />
                      ) : (
                        <input
                          class="settings-page-toggle"
                          type="checkbox"
                          aria-label={field.label}
                          checked={value === true}
                          onChange={(event) =>
                            changeSetting(
                              field.key,
                              event.currentTarget.checked,
                            )
                          }
                        />
                      )}
                    </SettingItem>
                  );
                })}
                {section.custom && section.id === "subtitles" && (
                  <SettingItem
                    wide
                    label="subtitle style"
                    description="how subtitles look in the player."
                  >
                    <SubtitleStyleEditor key={String(visible)} />
                  </SettingItem>
                )}
                {section.custom && section.id === "extensions" && (
                  <SettingItem
                    wide
                    label="extensions"
                    description="install chrome extensions into the browser."
                  >
                    <ExtensionManager active={visible && extensionsShown} />
                  </SettingItem>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
