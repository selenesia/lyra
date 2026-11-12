import type { ComponentChildren } from "preact";
import { IconCheckCircle2, IconChevronBottom } from "../icons";

interface PlayerMenuProps {
  className: string;
  open: boolean;
  onToggle: () => void;
  label: ComponentChildren;
  children: ComponentChildren;
  disabled?: boolean;
  ariaLabel?: string;
  triggerClassName?: string;
  panelClassName?: string;
  panelRole?: "listbox" | "group";
}

export function PlayerMenu({
  className,
  open,
  onToggle,
  label,
  children,
  disabled = false,
  ariaLabel,
  triggerClassName,
  panelClassName = "",
  panelRole = "listbox",
}: PlayerMenuProps) {
  return (
    <div class={`player-control-popover ${className}`}>
      <button
        type="button"
        class={`${triggerClassName ?? "player-selector-selected"}${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {triggerClassName ? (
          label
        ) : (
          <>
            <span>{label}</span>
            <IconChevronBottom size={12} class="selector-chevron" />
          </>
        )}
      </button>
      <div
        class={`player-selector-options${panelClassName ? ` ${panelClassName}` : ""}${open ? " is-open" : ""}`}
        role={panelRole}
        aria-hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}

export function PlayerOption({
  open,
  selected,
  solid = false,
  onSelect,
  children,
}: {
  open: boolean;
  selected?: boolean;
  solid?: boolean;
  onSelect: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      role="option"
      tabIndex={open ? 0 : -1}
      aria-selected={selected}
      class={selected === undefined ? undefined : selected ? "is-active" : ""}
      onClick={onSelect}
    >
      {selected === undefined ? children : <span>{children}</span>}
      {selected && (
        <IconCheckCircle2 size={12} solid={solid} class="player-option-check" />
      )}
    </button>
  );
}
