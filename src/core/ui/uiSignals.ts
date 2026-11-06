import { useSyncExternalStore } from "preact/compat";

export interface UiSignal<T> {
  value: T;
  subscribe(listener: () => void): () => void;
}

export function uiSignal<T>(initial: T): UiSignal<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get value() {
      return current;
    },
    set value(next) {
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useUiSignal<T>(signal: UiSignal<T>): T {
  return useSyncExternalStore(signal.subscribe, () => signal.value);
}

export const sidebarHiddenSignal = uiSignal(false);
export const gamesViewSignal = uiSignal(false);
export const animeViewSignal = uiSignal(false);
export const chatViewSignal = uiSignal(false);
export const currentUrlSignal = uiSignal<string>("");

export function initUiSignals(): void {
  const isHidden = localStorage.getItem("sidebarHidden") === "true";
  sidebarHiddenSignal.value = isHidden;
  document.body.classList.toggle("sidebar-hidden", isHidden);
}
