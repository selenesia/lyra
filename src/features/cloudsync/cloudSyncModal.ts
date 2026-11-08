import {
  USERNAME_IDLE_TEXT,
  PASSWORD_IDLE_TEXT,
  setFieldHint,
  USERNAME_UNCHECKED_TEXT,
  USERNAME_AVAILABLE_TEXT,
  USERNAME_TAKEN_TEXT,
  usernameHint,
  USERNAME_CHECKING_TEXT,
  passwordHint,
} from "./accountFields.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import {
  isManagedModalOpen,
  closeManagedModal,
  openManagedModal,
} from "../../core/ui/modal.ts";
import { isStatic } from "../../core/runtime/hosting.ts";
import type { CloudSync } from "./cloudsync.ts";
import { revisionTime } from "./syncMeta.ts";
import { canEncryptSync } from "./syncCrypto.ts";
const LOADING_SCREEN = `
    <div id="loading-screen" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--bg-body); z-index: 99999; display: flex; flex-direction: column; gap: 8px; justify-content: center; align-items: center; color: var(--text-muted); font-family: 'Lexend', sans-serif;">
        <h1 style="margin: 0; font-size: 1.2rem; font-weight: 300;">syncing data...</h1>
        <div id="loading-screen-progress" aria-live="polite" style="font-size: 13px; text-align: center; white-space: pre-line; min-height: 18px;"></div>
    </div>
`;
const LOADING_STALL_MS = 10_000;

function holdLoadingScreen(sync: CloudSync): void {
  if (sync._loadingTimer) clearTimeout(sync._loadingTimer);
  sync._loadingTimer = setTimeout(
    () => sync.hideLoadingScreen(),
    LOADING_STALL_MS,
  );
}

export function showLoadingScreen(this: CloudSync): void {
  if (!document.getElementById("loading-screen")) {
    const div = document.createElement("div");
    div.innerHTML = LOADING_SCREEN.trim();
    document.body.appendChild(div.firstChild!);
  }
  this._loadingStages = new Map();
  holdLoadingScreen(this);
}

export function showLoadingProgress(
  this: CloudSync,
  stage: string,
  text: string | null,
): void {
  const progress = document.getElementById?.("loading-screen-progress");
  if (!progress || !this._loadingStages) return;
  if (text === null) this._loadingStages.delete(stage);
  else this._loadingStages.set(stage, text);
  progress.textContent = [...this._loadingStages.values()].join("\n");
  holdLoadingScreen(this);
}

export function hideLoadingScreen(this: CloudSync): void {
  if (this._loadingTimer) clearTimeout(this._loadingTimer);
  this._loadingTimer = null;
  this._loadingStages = null;
  const screen = document.getElementById("loading-screen");
  if (screen) {
    screen.remove();
  }
}

export async function createCloudSyncModal(this: CloudSync): Promise<void> {
  if (isStatic || document.getElementById("cloudsync-modal")) return;

  const modal = document.createElement("div");
  modal.id = "cloudsync-modal";
  modal.className = "popup";
  modal.innerHTML = `
              <h2 id="auth-title">login</h2>
              <div id="auth-forms" class="input-container">
                  <form id="login-form">
                      <label>username</label>
                      <input type="text" id="login-username" placeholder="enter username" autocomplete="username" minlength="3" maxlength="20">

                      <label style="margin-top: 15px;">password</label>
                      <div style="position: relative;">
                          <input type="password" id="login-password" placeholder="enter password" autocomplete="current-password" maxlength="128" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                          <span class="password-toggle" data-target="login-password" style="position: absolute; right: 10px; top: 0; bottom: 5px; display: flex; align-items: center; cursor: pointer; color: var(--text-muted); font-size: 13px;">${svgIcon("IconEyeOpen")}</span>
                      </div>

                      <div style="text-align: center;">
                          <button type="submit" class="auth-action-btn" style="width: 50%; margin-top: 15px;">login</button>
                      </div>
                  </form>

                  <form id="register-form" style="display: none;" novalidate>
                      <label>username</label>
                      <input type="text" id="reg-username" placeholder="create username" autocomplete="username" maxlength="20" autocapitalize="none" spellcheck="false" aria-describedby="reg-username-feedback">
                      <div id="reg-username-feedback" class="auth-field-hint" data-tone="neutral" aria-live="polite">${USERNAME_IDLE_TEXT}</div>

                      <label style="margin-top: 20px;">password</label>
                      <div style="position: relative;">
                          <input type="password" id="reg-password" placeholder="create password" autocomplete="new-password" maxlength="128" aria-describedby="reg-password-feedback" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                          <span class="password-toggle" data-target="reg-password" style="position: absolute; right: 10px; top: 0; bottom: 5px; display: flex; align-items: center; cursor: pointer; color: var(--text-muted); font-size: 13px;">${svgIcon("IconEyeOpen")}</span>
                      </div>
                      <div id="reg-password-feedback" class="auth-field-hint" data-tone="neutral" aria-live="polite">${PASSWORD_IDLE_TEXT}</div>

                      <div style="text-align: center;">
                          <button type="submit" class="auth-action-btn" style="width: 60%; margin-top: 15px;">create account</button>
                          <p style="font-size: 12px; color: var(--status-error-text); margin-top: 10px; max-width: 80%; margin-left: auto; margin-right: auto;">
            save your password somewhere safe; all data will be forever lost if you forget it... /ᐠ - ˕ -マ
                          </p>
                      </div>
                  </form>

                  <div style="margin-top: 15px; margin-bottom: -20px; font-size: 13px; color: var(--text-muted); text-align: center;" id="auth-switch-container">
                      <span id="auth-prompt-text">don't have an account?</span> <span id="auth-action-text" class="link">create one!</span>
                  </div>
                  <div id="auth-error" style="color: var(--status-error-text); margin-top: 10px; font-size: 13px; min-height: 18px; text-align: center;"></div>
              </div>
              <div id="auth-logged-in" style="display: none; text-align: center;">
                  <p style="margin-bottom: 20px; font-size: 16px;">logged in as <span id="auth-user-display" style="color: var(--text-white);"></span></p>

                  <div style="margin-bottom: 20px;">
                      <span id="sync-status-indicator" style="color: var(--text-muted); font-size: 14px;">
                          ${this._statusText ?? "synced!! (˵◝ ⩊  ◜˵マ"}
                      </span>
                      <div id="sync-encryption-status" style="color: var(--text-muted); font-size: 12px; margin-top: 6px;"></div>
                  </div>

                  <form id="unlock-form" class="input-container" style="display: none; margin-bottom: 15px;">
                      <input type="password" id="unlock-password" placeholder="enter password" autocomplete="current-password" maxlength="128">
                      <button type="submit" id="unlock-btn" class="auth-action-btn" style="width: 60%; margin-top: 10px;">encrypt sync</button>
                  </form>

                  <button id="sync-now-btn" class="auth-action-btn auth-secondary-btn">
                      sync now
                  </button>

                  <button id="logout-btn" class="auth-action-btn auth-secondary-btn">
                      logout
                  </button>

                  <button id="delete-account-btn" class="auth-action-btn auth-secondary-btn auth-danger-btn">
                      delete account
                  </button>
              </div>
          <button id="close-cloudsync-modal" class="modal-close-btn" aria-label="close">
              ${svgIcon("IconCrossMedium")}
          </button>
      `;

  document.body.appendChild(modal);
  this.attachCloudSyncModalListeners(modal);
  this.updateModalState();
}

export function attachCloudSyncModalListeners(this: CloudSync, modal: HTMLElement): void {
  (
    modal.querySelector("#close-cloudsync-modal") as HTMLElement
  ).addEventListener("click", () => this.toggleCloudSyncModal());
  const loginForm = modal.querySelector<HTMLFormElement>("#login-form")!;
  const regForm = modal.querySelector<HTMLFormElement>("#register-form")!;

  const regUsername = modal.querySelector<HTMLInputElement>("#reg-username")!;
  const regUsernameFeedback = modal.querySelector<HTMLElement>(
    "#reg-username-feedback",
  )!;
  const regPassword = modal.querySelector<HTMLInputElement>("#reg-password")!;
  const regPasswordFeedback = modal.querySelector<HTMLElement>(
    "#reg-password-feedback",
  )!;

  let usernameCheckTimer: ReturnType<typeof setTimeout> | undefined;
  let usernameCheckAbort: AbortController | null = null;

  const showUsernameAvailability = (available: boolean | null) => {
    if (available === null) {
      setFieldHint(regUsernameFeedback, "neutral", USERNAME_UNCHECKED_TEXT);
    } else if (available) {
      setFieldHint(regUsernameFeedback, "success", USERNAME_AVAILABLE_TEXT);
    } else {
      setFieldHint(regUsernameFeedback, "error", USERNAME_TAKEN_TEXT);
    }
  };

  regUsername.addEventListener("input", () => {
    clearTimeout(usernameCheckTimer);
    usernameCheckAbort?.abort();
    usernameCheckAbort = null;

    const username = regUsername.value;
    const hint = usernameHint(username);
    if (!hint.valid) {
      setFieldHint(regUsernameFeedback, hint.tone, hint.text);
      return;
    }

    const known = this.usernameAvailability.get(username);
    if (known !== undefined) {
      showUsernameAvailability(known);
      return;
    }

    setFieldHint(regUsernameFeedback, "neutral", USERNAME_CHECKING_TEXT);
    usernameCheckTimer = setTimeout(async () => {
      const controller = new AbortController();
      usernameCheckAbort = controller;
      const available = await this.fetchUsernameAvailability(
        username,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      showUsernameAvailability(available);
    }, 350);
  });

  regPassword.addEventListener("input", () => {
    const hint = passwordHint(regPassword.value);
    setFieldHint(regPasswordFeedback, hint.tone, hint.text);
  });

  const promptText = modal.querySelector<HTMLElement>("#auth-prompt-text")!;
  const actionText = modal.querySelector<HTMLElement>("#auth-action-text")!;
  const authTitle = modal.querySelector<HTMLElement>("#auth-title")!;

  const loginUsername =
    modal.querySelector<HTMLInputElement>("#login-username")!;
  const loginPassword =
    modal.querySelector<HTMLInputElement>("#login-password")!;

  actionText.addEventListener("click", () => {
    const isLogin = loginForm.style.display !== "none";
    if (isLogin) {
      regUsername.value = loginUsername.value;
      regPassword.value = "";
      regUsername.dispatchEvent(new Event("input"));
      regPassword.dispatchEvent(new Event("input"));
      loginForm.style.display = "none";
      regForm.style.display = "block";
      authTitle.textContent = "create account";
      promptText.textContent = "already have an account?";
      actionText.textContent = "login!";
      (regUsername.value ? regPassword : regUsername).focus();
    } else {
      loginUsername.value = regUsername.value;
      loginPassword.value = "";
      loginForm.style.display = "block";
      regForm.style.display = "none";
      authTitle.textContent = "login";
      promptText.textContent = "don't have an account?";
      actionText.textContent = "create one!";
      (loginUsername.value ? loginPassword : loginUsername).focus();
    }
    this.showError("");
  });

  loginForm.addEventListener("submit", (e) => this.handleLogin(e));
  regForm.addEventListener("submit", (e) => this.handleRegister(e));
  modal
    .querySelector<HTMLFormElement>("#unlock-form")!
    .addEventListener("submit", (e) => this.handleUnlock(e));

  modal
    .querySelector<HTMLElement>("#sync-now-btn")!
    .addEventListener("click", () => {
      void this.sync(true);
    });

  modal
    .querySelector<HTMLElement>("#logout-btn")!
    .addEventListener("click", () => this.logout());

  const deleteBtn = modal.querySelector<HTMLElement>("#delete-account-btn")!;
  deleteBtn.addEventListener("click", () => {
    void this.deleteAccount();
  });

  document.addEventListener("click", (e) => {
    const overlay = document.getElementById("overlay");
    if (overlay && e.target === overlay && isManagedModalOpen(modal)) {
      this.toggleCloudSyncModal();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isManagedModalOpen(modal)) {
      this.toggleCloudSyncModal();
    }
  });

  const toggles = modal.querySelectorAll<HTMLElement>(".password-toggle");
  toggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const targetId = toggle.getAttribute("data-target");
      const input = document.getElementById(
        targetId!,
      ) as HTMLInputElement | null;
      if (!input) return;

      if (input.type === "password") {
        input.type = "text";
        toggle.innerHTML = svgIcon("IconEyeSlash");
      } else {
        input.type = "password";
        toggle.innerHTML = svgIcon("IconEyeOpen");
      }
    });
  });
}

export async function toggleCloudSyncModal(this: CloudSync): Promise<void> {
  if (isStatic) return;
  if (!document.getElementById("cloudsync-modal")) {
    await this.createCloudSyncModal();
  }

  const modal = document.getElementById("cloudsync-modal") as HTMLElement;
  if (isManagedModalOpen(modal)) {
    closeManagedModal(modal);
  } else {
    this.updateModalState();
    openManagedModal(modal);
  }
}

export function updateModalState(this: CloudSync): void {
  const loggedInView = document.getElementById("auth-logged-in");
  const formsView = document.getElementById("auth-forms");
  const userDisplay = document.getElementById("auth-user-display");
  const authTitle = document.getElementById("auth-title");
  const encryptionStatus = document.getElementById("sync-encryption-status");
  const unlockForm = document.getElementById("unlock-form");
  const unlockButton = document.getElementById("unlock-btn");

  if (this.isAuthenticated) {
    if (loggedInView) loggedInView.style.display = "block";
    if (formsView) formsView.style.display = "none";
    if (userDisplay) userDisplay.textContent = this.user.username ?? "";
    if (authTitle) authTitle.textContent = "cloud sync";
  } else {
    if (loggedInView) loggedInView.style.display = "none";
    if (formsView) formsView.style.display = "block";
    if (authTitle) authTitle.textContent = "login";
  }

  const encryptable = canEncryptSync();
  const needsKey = this.isAuthenticated && encryptable && !this.keys;
  if (encryptionStatus) {
    encryptionStatus.textContent = !this.isAuthenticated || !encryptable
      ? ""
      : this.keys
        ? `end-to-end encrypted${this.lastSyncedText()}`
        : this.locked
          ? "enter your password to unlock sync"
          : `enter your password to encrypt sync end-to-end${this.lastSyncedText()}`;
  }
  if (unlockForm) unlockForm.style.display = needsKey ? "block" : "none";
  if (unlockButton) {
    unlockButton.textContent = this.locked ? "unlock sync" : "encrypt sync";
  }

  const statusEl = document.querySelector<HTMLElement>("#auth-status");
  if (statusEl)
    statusEl.textContent = this.isAuthenticated
      ? (this.user.username ?? "")
      : "cloud sync";
}

export function lastSyncedText(this: CloudSync): string {
  const revision = this.syncMeta.last_synced;
  const time = revision ? revisionTime(revision) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return "; last synced just now";
  if (minutes < 60) return `; last synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `; last synced ${hours}h ago`;
  return `; last synced ${Math.round(hours / 24)}d ago`;
}

export function updateStatus(this: CloudSync, text: string, cls?: string): void {
  this._statusText = text;
  const ind = document.getElementById("sync-status-indicator");

  const updateEl = (el: HTMLElement | null): void => {
    if (!el) return;
    if (this._lastStatusText === text && this._lastStatusType === cls) return;
    this._lastStatusText = text;
    this._lastStatusType = cls;

    el.textContent = text;
  };

  updateEl(ind);
  if (cls === "success") this.updateModalState();
}

export function showError(this: CloudSync, message: string): void {
  const errorElement = document.getElementById("auth-error");
  if (errorElement) {
    errorElement.textContent = message;
    setTimeout(() => (errorElement.textContent = ""), 3000);
  }
}
