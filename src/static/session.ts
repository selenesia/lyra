import { staticBackend, staticBase } from "../core/runtime/hosting.ts";
import { negativeMessage } from "../core/runtime/messages.ts";
import "../assets/styles/base/themes.css";
import "../assets/styles/base/motion.css";
import "./static.css";

type Credentials = { access: string; refresh: string; nonce: string; expires: number; protocol: number };
type Session = { key: CryptoKey; jwk: JsonWebKey; credentials: Credentials };
const endpoint = `${staticBackend}/api/static/v1/`;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
const hash = async (value: string) => encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
let session: Session | null = null;
let renewing: Promise<Session> | null = null;
const routing = globalThis as typeof globalThis & {
  __LYRA_BACKENDS__?: string[];
  __LYRA_BACKEND_INDEX__?: number;
  __LYRA_BACKEND_CONTROL__?: { failed(origin: string): boolean; markFailed(): void; select(origin: string): boolean };
};
let recovering: Promise<void> | null = null;
let lastRecovery = 0;

async function backendAvailable(origin: string) {
  try {
    const response = await fetch(origin + "/api/static/v1/status", {
      credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    const status = response.ok ? await response.json() : null;
    return status?.protocol === 2 && status.enabled === true;
  } catch { return false; }
}

function recoverBackend(connectionFailed = false): Promise<void> {
  const backends = routing.__LYRA_BACKENDS__ || [];
  const control = routing.__LYRA_BACKEND_CONTROL__;
  if (backends.length < 2 || !control) return Promise.resolve();
  if (recovering) return recovering;
  if (Date.now() - lastRecovery < 5_000) return Promise.resolve();
  lastRecovery = Date.now();
  recovering = (async () => {
    if (!connectionFailed && await backendAvailable(staticBackend)) return;
    control.markFailed();
    for (const backend of backends) {
      if (backend === staticBackend || control.failed(backend)) continue;
      if (await backendAvailable(backend) && control.select(backend)) {
        await new Promise<never>(() => {});
      }
    }
  })().finally(() => { recovering = null; });
  return recovering;
}

async function proof(current: Session, url: string, method: string, credential: string) {
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  const header = json({ typ: "dpop+jwt", alg: "ES256", jwk: current.jwk });
  const payload = json({ htu: target.href, htm: method, iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(), ath: await hash(credential), nonce: current.credentials.nonce });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, current.key,
    new TextEncoder().encode(`${header}.${payload}`));
  return { authorization: `DPoP ${credential}`, dpop: `${header}.${payload}.${encode(new Uint8Array(signature))}` };
}

async function request(path: string, init: RequestInit) {
  return fetch(endpoint + path, { ...init, credentials: "omit", cache: "no-store",
    redirect: "error", signal: AbortSignal.timeout(10_000) });
}

async function credentials(response: Response): Promise<Credentials> {
  if (!response.ok) throw new Error(negativeMessage("connection unavailable"));
  const value = await response.json();
  if (value.protocol !== 2 || !Number.isSafeInteger(value.expires) || value.expires <= Date.now() ||
      [value.access, value.refresh, value.nonce].some((entry) => typeof entry !== "string" || !/^[\w-]{43}$/.test(entry))) {
    throw new Error(negativeMessage("connection unavailable"));
  }
  return value;
}

async function refresh(force = false): Promise<Session> {
  if (renewing) return renewing;
  if (!force && session && session.credentials.expires - Date.now() > 30_000) return session;
  renewing = (async () => {
    if (session) {
      const current = session;
      const response = await request("refresh", { method: "POST",
        headers: await proof(current, endpoint + "refresh", "POST", current.credentials.refresh) });
      if (response.status !== 401) {
        session = { ...current, credentials: await credentials(response) };
        return session;
      }
      session = null;
    }
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const response = await request("start", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwk, base: staticBase }) });
    session = { key: pair.privateKey, jwk, credentials: await credentials(response) };
    return session;
  })().finally(() => { renewing = null; });
  return renewing;
}

function panel(message: string) {
  document.querySelector(".static-connect")?.remove();
  const container = document.createElement("section");
  container.className = "static-connect";
  const card = document.createElement("div");
  const title = document.createElement("h1");
  title.textContent = "lyra";
  const status = document.createElement("p");
  status.textContent = message;
  status.setAttribute("role", "status");
  card.append(title, status);
  container.append(card);
  document.body.append(container);
  return { container, status };
}

export function staticFailure() {
  panel(negativeMessage("connection unavailable; retrying automatically"));
  const attempts = Math.min(Math.max(0, Number(sessionStorage.getItem("static-startup-retries")) || 0) + 1, 5);
  sessionStorage.setItem("static-startup-retries", String(attempts));
  setTimeout(() => location.reload(), Math.min(1_000 * 2 ** attempts, 30_000));
}

async function connect() {
  let view: ReturnType<typeof panel> | undefined;
  const delayed = setTimeout(() => { view = panel("connecting to server..."); }, 300);
  let delay = 1_000;
  try {
    for (;;) {
      try { await refresh(); return; }
      catch {
        await recoverBackend(true);
        clearTimeout(delayed);
        view ??= panel("");
        view.status.textContent = negativeMessage("connection unavailable; retrying automatically");
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); window.removeEventListener("online", done); resolve(); };
          const timer = setTimeout(done, delay + Math.random() * 500);
          window.addEventListener("online", done, { once: true });
        });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  } finally { clearTimeout(delayed); view?.container.remove(); }
}

export async function initializeStatic(player = false) {
  if (!isSecureContext || !navigator.serviceWorker) {
    panel(negativeMessage("a secure site with service worker support is required"));
    return new Promise<never>(() => {});
  }
  const selectedWorker = new URL("/b/sw.js", document.baseURI);
  if ((routing.__LYRA_BACKENDS__?.length || 0) > 1) selectedWorker.searchParams.set("__lyra_backend", String(routing.__LYRA_BACKEND_INDEX__));
  const workerUrl = selectedWorker.href;
  const registration = await navigator.serviceWorker.register(workerUrl, { scope: staticBase, updateViaCache: "none" });
  const controlled = () => navigator.serviceWorker.controller?.scriptURL === workerUrl && registration.active?.scriptURL === workerUrl;
  if (!controlled()) {
    let view: ReturnType<typeof panel> | undefined;
    const delayed = setTimeout(() => { view = panel("preparing lyra... (stuck? reload!)"); }, 300);
    try { await new Promise<void>((resolve, reject) => {
      let installing: ServiceWorker | null = null;
      const retire = () => {
        if (registration.waiting?.scriptURL === workerUrl && registration.active?.scriptURL !== workerUrl) {
          registration.active?.postMessage({ type: "static-retire", worker: workerUrl });
        }
      };
      const update = () => {
        installing?.removeEventListener("statechange", retire);
        installing = registration.installing;
        installing?.addEventListener("statechange", retire);
        retire();
      };
      const cleanup = () => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("controllerchange", done);
        registration.removeEventListener("updatefound", update);
        installing?.removeEventListener("statechange", retire);
      };
      const done = () => {
        if (!controlled()) return;
        cleanup(); resolve();
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(negativeMessage("connection unavailable"))); }, 60_000);
      navigator.serviceWorker.addEventListener("controllerchange", done);
      registration.addEventListener("updatefound", update);
      update();
      done();
    }); } finally { clearTimeout(delayed); view?.container.remove(); }
  }
  if (!crossOriginIsolated) {
    if (!sessionStorage.getItem("static-isolation-reload")) {
      sessionStorage.setItem("static-isolation-reload", "1");
      location.reload();
      return new Promise<never>(() => {});
    }
    panel(negativeMessage("this host or browser cannot provide the required isolation policies"));
    return new Promise<never>(() => {});
  }
  sessionStorage.removeItem("static-isolation-reload");
  if (player && window.parent !== window) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.source !== navigator.serviceWorker.controller && event.source !== registration.active) return;
    if (event.data?.type === "static-backend-unavailable") { void recoverBackend(); return; }
    if (event.data?.type !== "static-sign" || !event.ports[0]) return;
    const port = event.ports[0];
    const { url, method, renew } = event.data;
    void (async () => {
      try {
        if (typeof url !== "string" || !url.startsWith(endpoint) || new URL(url).origin !== staticBackend ||
            !["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(method)) throw new Error();
        const current = await refresh(renew === true).catch((error) => { void recoverBackend(true); throw error; });
        port.postMessage(await proof(current, url, method, current.credentials.access));
      } catch { port.postMessage(null); }
      finally { port.close(); }
    })();
  });
  await connect();
  sessionStorage.removeItem("static-startup-retries");
  const icon = document.querySelector<HTMLLinkElement>("link[data-static-icon]");
  if (icon?.dataset.staticIcon) {
    icon.href = staticBase + icon.dataset.staticIcon.replace(/^\/+/, "");
    delete icon.dataset.staticIcon;
  }
}
