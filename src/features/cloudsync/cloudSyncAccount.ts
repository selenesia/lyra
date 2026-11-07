import type { ToastController } from "../../core/ui/toast.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { appServiceWorkers } from "../../core/runtime/hosting.ts";
import {
  type AccountFailure,
  AccountAuthError,
  signIn,
  createAccount,
} from "./accountAuth.ts";
import {
  usernameSubmitError,
  setFieldHint,
  USERNAME_TAKEN_TEXT,
  passwordSubmitError,
} from "./accountFields.ts";
import type { AuthUser, CloudSync } from "./cloudsync.ts";
import { SYNC_LOCAL_DATABASE } from "./syncPolicy.ts";
import { SYNC_META_KEY } from "./syncMeta.ts";
import { canEncryptSync } from "./syncCrypto.ts";

interface SessionData {
  user: AuthUser;
  [key: string]: unknown;
}

const TOO_MANY_ATTEMPTS_TEXT =
  "too many attempts; wait a moment and try again... /ᐠ - ˕ -マ";
const SECURE_CONNECTION_TEXT =
  "sign in needs a secure (https) connection... /ᐠ - ˕ -マ";

function authFailure(error: unknown): AccountFailure | null {
  return error instanceof AccountAuthError ? error.failure : null;
}

export function rejectInsecureContext(this: CloudSync): boolean {
  if (canEncryptSync()) return false;
  if (window.showToast)
    window.showToast("error", SECURE_CONNECTION_TEXT, "IconExclamationTriangle");
  else this.showError(SECURE_CONNECTION_TEXT);
  return true;
}

export async function handleLogin(this: CloudSync, e: Event): Promise<void> {
  e.preventDefault();
  if (this.rejectInsecureContext()) return;
  const username = (
    document.getElementById("login-username") as HTMLInputElement
  ).value;
  const password = (
    document.getElementById("login-password") as HTMLInputElement
  ).value;
  (document.getElementById("login-password") as HTMLInputElement).value = "";

  let toastController: ToastController | null = null;
  if (window.showToast)
    toastController = window.showToast(
      "info",
      "logging in...",
      "IconArrowRotateClockwise",
      0,
    );

  try {
    const { session, master } = await signIn(username, password);
    try {
      this.setSession(session as unknown as SessionData);
      await this.adoptKeys(master);
    } finally {
      master.fill(0);
    }
    if (toastController) toastController.hide();
    this.toggleCloudSyncModal();
    await this.restoreData(false, true);
  } catch (error) {
    if (toastController) toastController.hide();
    const failure = authFailure(error);
    const message =
      failure === "invalid_credentials"
        ? "login failed... /ᐠ - ˕ -マ"
        : failure === "too_many_attempts"
          ? TOO_MANY_ATTEMPTS_TEXT
          : "connection error... /ᐠ - ˕ -マ";
    if (window.showToast)
      window.showToast("error", message, "IconExclamationTriangle");
    else this.showError(message);
    if (failure === "unavailable" && !this.isAuthenticated) {
      await this.checkAuthStatus();
    }
    if (failure !== "invalid_credentials" && failure !== "too_many_attempts") {
      console.error("login failed... /ᐠ - ˕ -マ");
    }
  }
}

export async function fetchUsernameAvailability(
  this: CloudSync,
  username: string,
  signal: AbortSignal,
): Promise<boolean | null> {
  try {
    const response = await fetch(
      `/api/auth/username?name=${encodeURIComponent(username)}`,
      { credentials: "same-origin", signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      available?: unknown;
    } | null;
    if (typeof payload?.available !== "boolean") return null;
    if (this.usernameAvailability.size >= 50) this.usernameAvailability.clear();
    this.usernameAvailability.set(username, payload.available);
    return payload.available;
  } catch {
    return null;
  }
}

export async function handleRegister(this: CloudSync, e: Event): Promise<void> {
  e.preventDefault();
  if (this.rejectInsecureContext()) return;
  const usernameInput = document.getElementById(
    "reg-username",
  ) as HTMLInputElement;
  const passwordInput = document.getElementById(
    "reg-password",
  ) as HTMLInputElement;
  const usernameFeedback = document.getElementById("reg-username-feedback");
  const passwordFeedback = document.getElementById("reg-password-feedback");
  const username = usernameInput.value;
  const password = passwordInput.value;

  const usernameError = usernameSubmitError(username);
  if (usernameError) {
    if (usernameFeedback) setFieldHint(usernameFeedback, "error", usernameError);
    usernameInput.focus();
    return;
  }
  if (this.usernameAvailability.get(username) === false) {
    if (usernameFeedback) {
      setFieldHint(usernameFeedback, "error", USERNAME_TAKEN_TEXT);
    }
    usernameInput.focus();
    return;
  }
  const passwordError = passwordSubmitError(password);
  if (passwordError) {
    if (passwordFeedback) setFieldHint(passwordFeedback, "error", passwordError);
    passwordInput.focus();
    return;
  }

  let toastController: ToastController | null = null;
  if (window.showToast)
    toastController = window.showToast(
      "info",
      "creating account...",
      "IconArrowRotateClockwise",
      0,
    );

  try {
    const { session, master } = await createAccount(username, password);
    passwordInput.value = "";
    try {
      this.setSession(session as unknown as SessionData);
      await this.adoptKeys(master);
    } finally {
      master.fill(0);
    }
    if (toastController) toastController.hide();
    this.toggleCloudSyncModal();
    this.syncMeta = { dirty: true, last_synced: null };
    this.saveMeta();
    await this.syncData(true);
  } catch (error) {
    if (toastController) toastController.hide();
    const failure = authFailure(error);
    if (failure === "username_taken") {
      this.usernameAvailability.set(username, false);
      if (usernameFeedback) {
        setFieldHint(usernameFeedback, "error", USERNAME_TAKEN_TEXT);
      }
      usernameInput.focus();
      return;
    }
    const message =
      failure === "too_many_attempts"
        ? TOO_MANY_ATTEMPTS_TEXT
        : failure === "invalid_credentials"
          ? "account creation failed... /ᐠ - ˕ -マ"
          : "connection error... /ᐠ - ˕ -マ";
    if (window.showToast)
      window.showToast("error", message, "IconExclamationTriangle");
    else this.showError(message);
    if (failure === "unavailable" && !this.isAuthenticated) {
      await this.checkAuthStatus();
    }
    if (failure !== "too_many_attempts" && failure !== "invalid_credentials") {
      console.error("account creation failed... /ᐠ - ˕ -マ");
    }
  }
}

export async function handleUnlock(this: CloudSync, e: Event): Promise<void> {
  e.preventDefault();
  if (this.rejectInsecureContext()) return;
  const input = document.getElementById(
    "unlock-password",
  ) as HTMLInputElement | null;
  const password = input?.value ?? "";
  if (input) input.value = "";
  if (!password || !this.user.username) return;

  let toastController: ToastController | null = null;
  if (window.showToast)
    toastController = window.showToast(
      "info",
      "securing sync...",
      "IconArrowRotateClockwise",
      0,
    );
  try {
    const { session, master } = await signIn(this.user.username, password);
    try {
      this.setSession(session as unknown as SessionData);
      await this.adoptKeys(master);
    } finally {
      master.fill(0);
    }
    if (!this.keys) throw new Error(negativeMessage("unlock failed"));
    toastController?.hide();
    this._lockNotified = false;
    this.setLocked(false);
    if (window.showToast)
      window.showToast("success", "sync is end-to-end encrypted!! (˵◝ ⩊  ◜˵マ", "IconCircleInfo");
    this.syncMeta.dirty = true;
    this.saveMeta();
    await this.sync(true);
  } catch (error) {
    toastController?.hide();
    const message =
      authFailure(error) === "too_many_attempts"
        ? TOO_MANY_ATTEMPTS_TEXT
        : "unlock failed... /ᐠ - ˕ -マ";
    if (window.showToast)
      window.showToast("error", message, "IconExclamationTriangle");
    else this.showError(message);
  }
}

export function setSession(this: CloudSync, session: SessionData): void {
  this.isAuthenticated = true;
  this.user = session.user;
  localStorage.setItem("auth_user", JSON.stringify(this.user));
  this.updateModalState();
  this.startPolling();
  document.dispatchEvent(new CustomEvent("cloudsync-session"));
}

export async function logout(this: CloudSync): Promise<void> {
  if (window.showToast) {
    window.showToast("info", "confirm logout?", "IconCircleInfo", [
      {
        text: "cancel",
        dismiss: true,
      },
      {
        text: "logout",
        class: "danger-btn",
        dismiss: true,
        callback: async () => {
          await this.performLogout();
        },
      },
    ]);
  } else {
    if (!confirm("confirm logout?")) return;
    void this.performLogout();
  }
}

export async function performLogout(this: CloudSync): Promise<void> {
  let toastController: ToastController | null = null;
  if (window.showToast)
    toastController = window.showToast(
      "info",
      "logging out...",
      "IconCircleInfo",
      0,
    );

  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    console.warn("logout failed... /ᐠ - ˕ -マ");
  }

  if (toastController) toastController.hide();

  this.stopPolling();
  this.isAuthenticated = false;
  this.user = {};
  this.keys = null;
  localStorage.removeItem("auth_user");
  localStorage.removeItem(SYNC_META_KEY);

  await this.wipeLocalData();

  window.bypassPreventClosing = true;
  window.location.reload();
}

export async function deleteAccount(this: CloudSync): Promise<void> {
  if (!this.isAuthenticated) return;

  if (window.showToast) {
    window.showToast(
      "info",
      "confirm deletion?",
      "IconExclamationTriangle",
      [
        {
          text: "cancel",
          dismiss: true,
        },
        {
          text: "delete",
          class: "danger-btn",
          dismiss: true,
          callback: async () => {
            await this.performDelete();
          },
        },
      ],
    );
  } else {
    if (
      confirm(
        "are you sure? this will delete your account and all synced data permanently... /ᐠ - ˕ -マ",
      )
    ) {
      void this.performDelete();
    }
  }
}

export async function performDelete(this: CloudSync): Promise<void> {
  let toastController: ToastController | null = null;
  if (window.showToast)
    toastController = window.showToast(
      "info",
      "deleting account...",
      "IconExclamationTriangle",
      0,
    );

  try {
    const response = await fetch("/api/auth/me", {
      method: "DELETE",
      credentials: "same-origin",
    });

    if (response.ok) {
      if (toastController) toastController.hide();
      this.stopPolling();
      this.isAuthenticated = false;
      this.user = {};
      this.keys = null;
      localStorage.removeItem("auth_user");
      localStorage.removeItem(SYNC_META_KEY);

      await this.wipeLocalData();

      window.bypassPreventClosing = true;
      window.location.reload();
    } else {
      if (toastController) toastController.hide();
      if (window.showToast)
        window.showToast(
          "error",
          "account deletion failed... /ᐠ - ˕ -マ",
          "IconExclamationTriangle",
        );
      else alert("account deletion failed... /ᐠ - ˕ -マ");
    }
  } catch {
    if (toastController) toastController.hide();
    if (window.showToast)
      window.showToast(
        "error",
        "account deletion failed... /ᐠ - ˕ -マ",
        "IconExclamationTriangle",
      );
    else alert("account deletion failed... /ᐠ - ˕ -マ");
    console.error("account deletion failed... /ᐠ - ˕ -マ");
  }
}

export async function wipeLocalData(this: CloudSync): Promise<void> {
  try {
    const preserveKeys = ["alertClosed", "lyraVisited", "lyraVersion"];

    const preservedData: Record<string, string> = {};
    preserveKeys.forEach((key) => {
      const value = localStorage.getItem(key);
      if (value !== null) preservedData[key] = value;
    });

    localStorage.clear();
    sessionStorage.clear();

    localStorage.removeItem("lyra-bookmarks");

    Object.keys(preservedData).forEach((key) => {
      localStorage.setItem(key, preservedData[key]!);
    });
  } catch {
    console.error("[cloudsync] storage wipe failed... /ᐠ - ˕ -マ");
  }

  try {
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
  } catch {
    console.warn("cookie clear failed... /ᐠ - ˕ -マ");
  }

  if ("indexedDB" in window) {
    try {
      indexedDB.deleteDatabase(SYNC_LOCAL_DATABASE);
      if (typeof indexedDB.databases === "function") {
        const dbs = await indexedDB.databases();
        for (const dbInfo of dbs) {
          if (dbInfo.name) {
            indexedDB.deleteDatabase(dbInfo.name!);
          }
        }
      }
    } catch {
      console.warn("[cloudsync] indexeddb wipe failed... /ᐠ - ˕ -マ");
    }
  }

  if ("serviceWorker" in navigator) {
    try {
      const registrations = await appServiceWorkers();
      await Promise.all(registrations.map((r) => r.unregister()));
    } catch {
      console.warn("[cloudsync] service worker cleanup failed... /ᐠ - ˕ -マ");
    }
  }

  if ("caches" in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      console.warn("[cloudsync] cache cleanup failed... /ᐠ - ˕ -マ");
    }
  }
}
