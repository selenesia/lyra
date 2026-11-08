import { memo, createPortal } from "preact/compat";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { DEFAULT_BOOKMARKS, type Bookmark } from "../../core/config/config.ts";
import { canonicalize, encodeMochiUrl } from "../../core/runtime/utils.ts";
import { useManagedModal } from "../../core/ui/modal.ts";
import { toast } from "../../core/ui/toast.ts";
import { useImageLoad } from "../../hooks/useImageLoad.ts";
import { warmExtensionRuntime } from "../../core/proxy/proxyRuntime.ts";
import { isStatic } from "../../core/runtime/hosting.ts";
import { invokeWindowAction } from "../../core/browser/windowActions.ts";
import {
  IconCrossMedium,
  IconPencil,
  IconPlusMedium,
  IconVideoClip,
  IconAudio,
  IconGamecontroller,
  IconChat,
} from "../icons";
import type { IconProps } from "../icons/IconBase";
import "../../assets/styles/browser/bookmarks.css";

function getBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem("lyra-bookmarks");
    if (!raw) {
      const defaults = DEFAULT_BOOKMARKS.slice();
      localStorage.setItem("lyra-bookmarks", JSON.stringify(defaults));
      if (!isStatic) localStorage.setItem("lyra-bookmarks-chat-added", "1");
      return defaults;
    }
    const bookmarks: Bookmark[] = JSON.parse(raw);
    const legacyWatchIndex = bookmarks.findIndex(
      (bookmark) =>
        bookmark.name.toLowerCase() === "anime" && /^lyra:\/\/anime\/?$/i.test(bookmark.url),
    );
    if (legacyWatchIndex !== -1) {
      bookmarks[legacyWatchIndex] = { name: "watch", url: "lyra://watch" };
      saveBookmarks(bookmarks);
    }
    const soundcloudIndex = bookmarks.findIndex(
      (bookmark) =>
        bookmark.name.toLowerCase() === "soundcloud" &&
        canonicalize(bookmark.url) === canonicalize("https://soundcloud.com/"),
    );
    if (soundcloudIndex !== -1) {
      if (
        bookmarks.some((bookmark) => isInternalBookmark(bookmark.url, "watch"))
      ) {
        bookmarks.splice(soundcloudIndex, 1);
      } else {
        bookmarks[soundcloudIndex] = { name: "watch", url: "lyra://watch" };
      }
      if (
        bookmarks.length < 5 &&
        !bookmarks.some((bookmark) => isInternalBookmark(bookmark.url, "games"))
      ) {
        bookmarks.push({ name: "games", url: "lyra://games" });
      }
      saveBookmarks(bookmarks);
    }
    if (!isStatic && !localStorage.getItem("lyra-bookmarks-chat-added")) {
      if (
        bookmarks.length < 5 &&
        !bookmarks.some((bookmark) => isInternalBookmark(bookmark.url, "chat"))
      ) {
        const watchIndex = bookmarks.findIndex((bookmark) =>
          isInternalBookmark(bookmark.url, "watch"),
        );
        bookmarks.splice(watchIndex === -1 ? bookmarks.length : watchIndex + 1, 0, {
          name: "chat",
          url: "lyra://chat",
        });
        saveBookmarks(bookmarks);
      }
      localStorage.setItem("lyra-bookmarks-chat-added", "1");
    }
    return bookmarks.slice(0, 5);
  } catch {
    return [];
  }
}

function isInternalBookmark(url: string, page?: "watch" | "games" | "chat"): boolean {
  const match = url.match(/^lyra:\/\/(anime|watch|games|chat)\/?$/i);
  const target = match?.[1]?.toLowerCase() === "anime" ? "watch" : match?.[1]?.toLowerCase();
  return !!match && (!page || target === page);
}

function saveBookmarks(bookmarks: Bookmark[]) {
  localStorage.setItem("lyra-bookmarks", JSON.stringify(bookmarks));
}

const legacyIconMap: Record<string, (props: IconProps) => any> = {
  Film: IconVideoClip,
  Music: IconAudio,
};

const BookmarkIcon = memo(function BookmarkIcon({
  bookmark,
}: {
  bookmark: Bookmark;
}) {
  const isFaIcon =
    bookmark.icon &&
    (bookmark.icon.startsWith("fa-") ||
      bookmark.icon.includes(" fa-") ||
      /^fa[srbltd]? /.test(bookmark.icon));

  let src = bookmark.icon;
  if (!isInternalBookmark(bookmark.url) && !isFaIcon && !src) {
    try {
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${new URL(bookmark.url).hostname}&sz=64`;
      src = "/!cover!/" + encodeMochiUrl(faviconUrl) + "/";
    } catch {
      src = "";
    }
  }
  const image = useImageLoad(isFaIcon ? "" : src);

  if (isFaIcon && bookmark.icon) {
    const parts = bookmark.icon.trim().split(/\s+/);
    let name = "";
    for (const part of parts) {
      const match = part.match(/^fa-(.+)$/);
      if (match) {
        const value = match[1]!;
        if (
          value !== "solid" &&
          value !== "regular" &&
          value !== "light" &&
          value !== "brands"
        ) {
          name = value;
        }
      }
    }
    const kebab = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const pascal = kebab.charAt(0).toUpperCase() + kebab.slice(1);
    const Icon = legacyIconMap[pascal];
    if (Icon) {
      return (
        <div class="bookmark-icon" data-bookmark-url={bookmark.url}>
          <Icon />
        </div>
      );
    }
  }

  if (isInternalBookmark(bookmark.url, "watch")) {
    return (
      <div class="bookmark-icon">
        <IconVideoClip size={22} solid />
      </div>
    );
  }
  if (isInternalBookmark(bookmark.url, "games")) {
    return (
      <div class="bookmark-icon">
        <IconGamecontroller solid />
      </div>
    );
  }

  if (isInternalBookmark(bookmark.url, "chat")) {
    return (
      <div class="bookmark-icon">
        <IconChat solid />
      </div>
    );
  }

  if (image.errored) {
    return (
      <div class="bookmark-icon">{bookmark.name.charAt(0).toUpperCase()}</div>
    );
  }

  return (
    <div
      class={`bookmark-icon${!image.loaded ? " skeleton" : ""}`}
      data-bookmark-url={bookmark.url}
    >
      <img
        key={image.requestKey}
        class="bookmark-icon-img"
        loading="lazy"
        decoding="async"
        ref={image.imgRef}
        src={image.src}
        onLoad={image.onLoad}
        onError={image.onError}
      />
    </div>
  );
});

export default function Bookmarks() {
  const [bookmarks, setBookmarks] = useState(() => getBookmarks());
  const [isEditMode, setIsEditMode] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setBookmarks(getBookmarks()), []);

  useEffect(() => {
    const handler = () => reload();
    document.addEventListener("cloudsync-restored", handler);
    const storageHandler = (e: StorageEvent) => {
      if (e.key === "lyra-bookmarks") reload();
    };
    window.addEventListener("storage", storageHandler);
    return () => {
      document.removeEventListener("cloudsync-restored", handler);
      window.removeEventListener("storage", storageHandler);
    };
  }, [reload]);

  const deleteBookmark = (index: number) => {
    const bm = [...bookmarks];
    bm.splice(index, 1);
    saveBookmarks(bm);
    setBookmarks(bm);
  };

  const openPrompt = (index: number | null = null) => {
    setEditIndex(index);
    setShowPrompt(true);
    if (index !== null) {
      requestAnimationFrame(() => {
        const bm = bookmarks[index];
        if (bm) {
          if (nameRef.current) nameRef.current.value = bm.name || "";
          if (urlRef.current) urlRef.current.value = bm.url || "";
        }
      });
    }
  };

  const closePrompt = () => {
    setShowPrompt(false);
    setEditIndex(null);
  };

  const handleSave = (closeWithAnimation?: () => void) => {
    const name = nameRef.current?.value?.trim() ?? "";
    let rawUrl = urlRef.current?.value?.trim() ?? "";
    if (!name || !rawUrl) {
      toast.error("name and url cannot be empty... /ᐠ - ˕ -マ", "warning");
      return;
    }
    if (isInternalBookmark(rawUrl)) {
      rawUrl = rawUrl.toLowerCase().replace(/\/$/, "");
    } else if (!/^https?:\/\//i.test(rawUrl)) {
      rawUrl = "https://" + rawUrl;
    }
    try {
      if (!isInternalBookmark(rawUrl)) new URL(rawUrl);
    } catch {
      toast.error("please enter a valid url... /ᐠ - ˕ -マ", "warning");
      return;
    }
    const canonUrl = canonicalize(rawUrl);
    const bm = [...bookmarks];
    const others =
      editIndex !== null ? bm.filter((_, i) => i !== editIndex) : bm;
    if (others.some((s) => canonicalize(s.url) === canonUrl)) {
      toast.error("that bookmark url already exists... /ᐠ - ˕ -マ", "warning");
      return;
    }
    if (editIndex === null && bm.length >= 5) {
      toast.error("you can only have 5 bookmarks... /ᐠ - ˕ -マ", "warning");
      return;
    }

    const newBm: Bookmark = { name, url: canonUrl };
    if (editIndex !== null && bookmarks[editIndex]?.icon)
      newBm.icon = bookmarks[editIndex]!.icon;
    if (editIndex !== null) bm[editIndex] = newBm;
    else bm.push(newBm);
    saveBookmarks(bm);
    setBookmarks(bm);
    closeWithAnimation?.();
  };

  return (
    <div
      id="bookmarks-container"
      class={isEditMode ? "bookmarks-edit-mode" : ""}
      onMouseEnter={warmExtensionRuntime}
    >
      <div class="bookmarks-header">
        <h3 id="bookmarks-title">bookmarks</h3>
        <button
          id="bookmarks-edit-toggle"
          onClick={() => setIsEditMode(!isEditMode)}
        >
          {isEditMode ? "done" : "edit"}
        </button>
      </div>
      <div class="bookmarks-wrapper">
        <ul id="bookmarks-list">
          {bookmarks.map((bookmark, index) => isStatic && isInternalBookmark(bookmark.url, "chat") ? null : (
            <li key={bookmark.url + index} class="bookmark-item">
              <a
                href="#"
                class="bookmark-link"
                onClick={(e) => {
                  e.preventDefault();
                  if (isInternalBookmark(bookmark.url, "watch")) {
                    window.showWatchMenu?.();
                  } else if (isInternalBookmark(bookmark.url, "games")) {
                    window.showGameMenu?.();
                  } else if (isInternalBookmark(bookmark.url, "chat")) {
                    invokeWindowAction("showChatPage");
                  } else {
                    (window.Lyra as any)?.handleSearch(bookmark.url);
                  }
                }}
              >
                <BookmarkIcon bookmark={bookmark} />
                <span class="bookmark-name">{bookmark.name}</span>
              </a>
              <button
                class="bookmark-delete-trigger"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteBookmark(index);
                }}
              >
                <IconCrossMedium size={12} />
              </button>
              <button
                class="bookmark-edit-trigger"
                onClick={(e) => {
                  e.stopPropagation();
                  openPrompt(index);
                }}
              >
                <IconPencil size={12} />
              </button>
            </li>
          ))}
          <li
            class="bookmark-item-add"
            style={{
              display:
                isEditMode && bookmarks.length < 5 ? "list-item" : "none",
            }}
          >
            <button id="add-bookmark-btn" onClick={() => openPrompt()}>
              <IconPlusMedium />
            </button>
          </li>
        </ul>
      </div>
      {showPrompt &&
        createPortal(
          <BookmarkModal
            isEditing={editIndex !== null}
            nameRef={nameRef}
            urlRef={urlRef}
            onSave={handleSave}
            onCancel={closePrompt}
          />,
          document.body,
        )}
    </div>
  );
}

function BookmarkModal({
  isEditing,
  nameRef,
  urlRef,
  onSave,
  onCancel,
}: {
  isEditing: boolean;
  nameRef: { current: HTMLInputElement | null };
  urlRef: { current: HTMLInputElement | null };
  onSave: (closeWithAnimation: () => void) => void;
  onCancel: () => void;
}) {
  const [isClosing, setIsClosing] = useState(false);
  const isClosingRef = useRef(false);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
  }, []);

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: true,
    isClosing,
    onRequestClose: handleClose,
    onCloseComplete: onCancel,
  });

  useEffect(() => {
    window.hideBookmarkModal = () => handleClose();
    return () => {
      delete window.hideBookmarkModal;
    };
  }, [handleClose]);

  return (
    <div
      id="bookmark-modal"
      class={`popup ${modalStateClass}`}
      onAnimationEnd={onAnimationEnd}
    >
      <h2>{isEditing ? "edit bookmark" : "add bookmark"}</h2>
      <div class="input-container">
        <label>bookmark name</label>
        <input
          type="text"
          id="bookmarkName"
          ref={nameRef}
          placeholder="my cool site"
          autocomplete="off"
        />
        <label class="bookmark-modal-url-label">bookmark url</label>
        <input
          type="text"
          id="bookmarkUrl"
          ref={urlRef}
          placeholder="https://example.com/"
          autocomplete="off"
        />
        <div class="bookmark-modal-actions">
          <button id="saveBookmarkBtn" onClick={() => onSave(handleClose)}>
            save
          </button>
          <button id="cancelBookmarkBtn" onClick={handleClose}>
            cancel
          </button>
        </div>
      </div>
      <button
        type="button"
        class="modal-close-btn"
        aria-label="close"
        onClick={handleClose}
      >
        <IconCrossMedium />
      </button>
    </div>
  );
}
