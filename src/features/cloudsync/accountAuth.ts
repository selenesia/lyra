import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  legacyMaster,
  newMaster,
  unwrapMaster,
  wrapMaster,
  type SyncBytes,
} from "./syncCrypto.ts";

export type AccountFailure =
  | "invalid_credentials"
  | "username_taken"
  | "too_many_attempts"
  | "unavailable";

const FAILURE_TEXT: Record<AccountFailure, string> = {
  invalid_credentials: "invalid credentials",
  username_taken: "username is unavailable",
  too_many_attempts: "too many attempts",
  unavailable: "account service is unavailable",
};

export class AccountAuthError extends Error {
  readonly failure: AccountFailure;
  readonly retryAfter: number | undefined;

  constructor(failure: AccountFailure, retryAfter?: number) {
    super(negativeMessage(FAILURE_TEXT[failure]));
    this.name = "AccountAuthError";
    this.failure = failure;
    this.retryAfter = retryAfter;
  }
}

export interface AccountSession {
  session: Record<string, unknown>;
  master: SyncBytes;
}

type Opaque = typeof import("@serenity-kit/opaque");

let opaqueLoad: Promise<Opaque> | null = null;

function loadOpaque(): Promise<Opaque> {
  opaqueLoad ??= import("@serenity-kit/opaque")
    .then(async (opaque) => {
      await opaque.ready;
      return opaque;
    })
    .catch((error: unknown) => {
      opaqueLoad = null;
      throw error;
    });
  return opaqueLoad;
}

function accountError(error: unknown): AccountAuthError {
  return error instanceof AccountAuthError
    ? error
    : new AccountAuthError("unavailable");
}

function statusFailure(status: number): AccountFailure {
  if (status === 401) return "invalid_credentials";
  if (status === 409) return "username_taken";
  if (status === 429) return "too_many_attempts";
  return "unavailable";
}

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get("Retry-After") ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new AccountAuthError(
      statusFailure(response.status),
      response.status === 429 ? retryAfter(response) : undefined,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AccountAuthError("unavailable");
  }
  return payload as Record<string, unknown>;
}

function field(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || !value) {
    throw new AccountAuthError("unavailable");
  }
  return value;
}

function syncSalt(session: Record<string, unknown>): string {
  const user = session.user;
  if (!user || typeof user !== "object") {
    throw new AccountAuthError("unavailable");
  }
  return field(user as Record<string, unknown>, "sync_salt");
}

async function upgradeLegacy(
  opaque: Opaque,
  username: string,
  password: string,
  master: SyncBytes,
): Promise<void> {
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const started = await post("/api/auth/upgrade/start", {
    request: registrationRequest,
  });
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: field(started, "response"),
    password,
  });
  await post("/api/auth/upgrade/finish", {
    credential_id: field(started, "credential_id"),
    record: registrationRecord,
    wrapped_key: await wrapMaster(exportKey, master, username),
  });
}

async function legacySignIn(
  opaque: Opaque,
  username: string,
  password: string,
  typed: string,
): Promise<AccountSession> {
  const session = await post("/api/auth/login", { username, password: typed });
  const master = await legacyMaster(password, syncSalt(session));
  await upgradeLegacy(opaque, username, password, master).catch(
    () => undefined,
  );
  return { session, master };
}

async function opaqueSignIn(
  username: string,
  typed: string,
): Promise<AccountSession> {
  const password = typed.normalize("NFC");
  const opaque = await loadOpaque();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const started = await post("/api/auth/login/start", {
    username,
    request: startLoginRequest,
  });
  if (started.legacy === true) {
    return legacySignIn(opaque, username, password, typed);
  }
  const finished = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: field(started, "response"),
    password,
  });
  if (!finished) throw new AccountAuthError("invalid_credentials");
  const session = await post("/api/auth/login/finish", {
    login_id: field(started, "login_id"),
    finalization: finished.finishLoginRequest,
  });
  const master = await unwrapMaster(
    finished.exportKey,
    field(session, "wrapped_key"),
    username,
  );
  return { session, master };
}

async function opaqueRegister(
  username: string,
  password: string,
): Promise<AccountSession> {
  const opaque = await loadOpaque();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const started = await post("/api/auth/register/start", {
    username,
    request: registrationRequest,
  });
  const credentialId = field(started, "credential_id");
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: field(started, "response"),
    password,
  });
  const master = newMaster();
  try {
    const session = await post("/api/auth/register/finish", {
      username,
      credential_id: credentialId,
      record: registrationRecord,
      wrapped_key: await wrapMaster(exportKey, master, username),
    });
    return { session, master };
  } catch (error) {
    master.fill(0);
    throw error;
  }
}

export async function signIn(
  username: string,
  password: string,
): Promise<AccountSession> {
  try {
    return await opaqueSignIn(username, password);
  } catch (error) {
    throw accountError(error);
  }
}

export async function createAccount(
  username: string,
  password: string,
): Promise<AccountSession> {
  try {
    return await opaqueRegister(username, password.normalize("NFC"));
  } catch (error) {
    throw accountError(error);
  }
}
