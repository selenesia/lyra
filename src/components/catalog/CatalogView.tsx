import type { ComponentChildren, RefObject } from "preact";
import { useRef } from "preact/hooks";
import { IconMagnifyingGlass2 } from "../icons";
import EditableField from "../EditableField.tsx";
import CatalogCanvas, { type CanvasCard } from "./CatalogCanvas.tsx";
import "../../assets/styles/catalog/catalog.css";

interface CatalogViewProps<T> {
  id: string;
  className: string;
  inputId: string;
  visible: boolean;
  searchBarRef: RefObject<HTMLDivElement>;
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  showSkeleton: boolean;
  items: readonly T[];
  getCard: (item: T) => CanvasCard;
  onSelect: (item: T) => void;
  posters?: boolean;
  emptyMessage?: string | null;
  statusMessage?: string | null;
  beforeGrid?: ComponentChildren;
}

export default function CatalogView<T>({
  id,
  className,
  inputId,
  visible,
  searchBarRef,
  query,
  placeholder,
  onQueryChange,
  showSkeleton,
  items,
  getCard,
  onSelect,
  posters = false,
  emptyMessage,
  statusMessage,
  beforeGrid,
}: CatalogViewProps<T>) {
  const opened = useRef(false);
  if (visible) opened.current = true;
  if (!opened.current) return null;
  const gridVisible = items.length > 0 || showSkeleton;

  return (
    <section
      id={id}
      class={`catalog-page ${className}${visible ? " is-visible is-active" : ""}`}
      aria-hidden={!visible}
    >
      <div class="catalog-topbar">
        <div
          class="search-bar catalog-search-bar"
          ref={searchBarRef}
        >
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <IconMagnifyingGlass2 class="catalog-search-icon" />
          <EditableField
            id={inputId}
            label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={onQueryChange}
          />
        </div>
      </div>

      <div class="catalog-grid-container">
        {beforeGrid}
        <div
          style={gridVisible ? "display:block" : "display:none"}
        >
          <CatalogCanvas
            items={items}
            getCard={getCard}
            onSelect={onSelect}
            posters={posters}
            loading={showSkeleton}
            active={visible && gridVisible}
          />
        </div>
        {emptyMessage && <p class="no-results">{emptyMessage}</p>}
        {statusMessage && <p class="no-results">{statusMessage}</p>}
      </div>
    </section>
  );
}
