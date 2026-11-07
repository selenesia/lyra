import { negativeMessage, positiveMessage } from "../../core/runtime/messages.ts";

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 20;
const PASSWORD_MIN_LENGTH = 8;

export type HintTone = "neutral" | "error" | "success";

export interface FieldHint {
  tone: HintTone;
  text: string;
  valid: boolean;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

export const USERNAME_IDLE_TEXT = "3-20 letters, numbers, or underscores";
export const PASSWORD_IDLE_TEXT = "at least 8 characters";

function characterCount(value: string): number {
  return [...value].length;
}

export function usernameHint(username: string): FieldHint {
  if (username.length === 0) {
    return { tone: "neutral", text: USERNAME_IDLE_TEXT, valid: false };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return {
      tone: "error",
      text: negativeMessage("use letters, numbers, and underscores only"),
      valid: false,
    };
  }
  if (username.length < USERNAME_MIN_LENGTH) {
    return {
      tone: "neutral",
      text: `${username.length}/${USERNAME_MIN_LENGTH} characters minimum`,
      valid: false,
    };
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return {
      tone: "error",
      text: negativeMessage(`usernames max out at ${USERNAME_MAX_LENGTH} characters`),
      valid: false,
    };
  }
  return { tone: "neutral", text: "", valid: true };
}

export function passwordHint(password: string): FieldHint {
  const length = characterCount(password);
  if (length === 0) {
    return { tone: "neutral", text: PASSWORD_IDLE_TEXT, valid: false };
  }
  if (length < PASSWORD_MIN_LENGTH) {
    return {
      tone: "neutral",
      text: `${length}/${PASSWORD_MIN_LENGTH} characters minimum`,
      valid: false,
    };
  }
  return { tone: "success", text: positiveMessage("long enough"), valid: true };
}

export function usernameSubmitError(username: string): string | null {
  if (username.length === 0) return negativeMessage("pick a username");
  const hint = usernameHint(username);
  if (hint.valid) return null;
  if (hint.tone === "error") return hint.text;
  return negativeMessage(`username needs at least ${USERNAME_MIN_LENGTH} characters`);
}

export function passwordSubmitError(password: string): string | null {
  if (password.length === 0) return negativeMessage("pick a password");
  if (passwordHint(password).valid) return null;
  return negativeMessage(`password needs at least ${PASSWORD_MIN_LENGTH} characters`);
}

export function setFieldHint(
  element: HTMLElement,
  tone: HintTone,
  text: string,
): void {
  element.dataset.tone = tone;
  element.textContent = text;
}

export const USERNAME_CHECKING_TEXT = "checking availability...";
export const USERNAME_AVAILABLE_TEXT = positiveMessage("username is available");
export const USERNAME_TAKEN_TEXT = negativeMessage("username already taken; try another");
export const USERNAME_UNCHECKED_TEXT = negativeMessage("couldn't check availability right now");
