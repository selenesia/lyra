const STORAGE_KEY = "lyra-tutorial-seen";

export type TutorialGuide = "home" | "chat";

function storageKey(guide: TutorialGuide): string {
  return guide === "home" ? STORAGE_KEY : "lyra-chat-tutorial-seen";
}

function completionVersion(guide: TutorialGuide): string {
  const version = guide === "chat" ? "2" : "1";
  const revision = import.meta.env.VITE_TUTORIAL_REVISION;
  return revision ? `${version}:${revision}` : version;
}

export function tutorialSeen(guide: TutorialGuide = "home"): boolean {
  try { return localStorage.getItem(storageKey(guide)) === completionVersion(guide); } catch { return false; }
}

export function markTutorialSeen(guide: TutorialGuide = "home"): void {
  try { localStorage.setItem(storageKey(guide), completionVersion(guide)); } catch { }
}

export function forgetTutorialSeen(guide: TutorialGuide): void {
  try { localStorage.removeItem(storageKey(guide)); } catch { }
}
