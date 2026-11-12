const STORAGE_KEY = "lyra-tutorial-seen";

export function tutorialSeen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}

export function markTutorialSeen(): void {
  try { localStorage.setItem(STORAGE_KEY, "1"); } catch { }
}
