const STORAGE_KEY = "lyra-tutorial-seen";

export type TutorialGuide = "home" | "chat";

function storageKey(guide: TutorialGuide): string {
  return guide === "home" ? STORAGE_KEY : "lyra-chat-tutorial-seen";
}

export function tutorialSeen(guide: TutorialGuide = "home"): boolean {
  try { return localStorage.getItem(storageKey(guide)) === "1"; } catch { return false; }
}

export function markTutorialSeen(guide: TutorialGuide = "home"): void {
  try { localStorage.setItem(storageKey(guide), "1"); } catch { }
}
