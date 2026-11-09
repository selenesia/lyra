import { useSlidingPill } from "../../hooks/useSlidingPill.ts";

export interface SeasonTabOption {
  key: string | number;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export function SeasonTabs({ options }: { options: SeasonTabOption[] }) {
  const activeKey = options.find((option) => option.active)?.key;
  const setTrack = useSlidingPill('[aria-selected="true"]', activeKey);

  return (
    <div class="episode-season-tabs" role="tablist" ref={setTrack}>
      <span class="episode-season-pill" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={option.active}
          class={`episode-season-tab${option.active ? " is-active" : ""}`}
          onClick={option.onSelect}
        >
          <span class="episode-season-chip" />
          <span class="episode-season-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
