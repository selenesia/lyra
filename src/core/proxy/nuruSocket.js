export function nuruSocketClass(NativeWebSocket, wispPath) {
  if (NativeWebSocket[Symbol.for("lyra.nuruSocket")]) return NativeWebSocket;

  function nuruTickets() {
    const endpoint = new URL("/api/static/v1/", globalThis.location.origin).href;
    const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const json = (value) => encode(new TextEncoder().encode(JSON.stringify(value)));
    const hash = async (value) => encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
    const request = (route, init = {}) => fetch(endpoint + route, { ...init, credentials: "omit", cache: "no-store",
      redirect: "error", signal: AbortSignal.timeout(10_000) });
    let enabled = null;
    let checked = 0;
    let session = null;
    let renewing = null;

    async function available() {
      if (enabled === true || (enabled === false && Date.now() - checked < 60_000)) return enabled;
      try {
        const response = await request("status");
        if (!response.ok) return false;
        enabled = (await response.json()).nuru === true;
        checked = Date.now();
        return enabled;
      } catch { return false; }
    }

    async function proof(current, route, credential) {
      const header = json({ typ: "dpop+jwt", alg: "ES256", jwk: current.jwk });
      const payload = json({ htu: `${current.credentials.backend}/api/static/v1/${route}`, htm: "POST",
        iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), ath: await hash(credential),
        nonce: current.credentials.nonce });
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, current.key,
        new TextEncoder().encode(`${header}.${payload}`));
      return { authorization: `DPoP ${credential}`, dpop: `${header}.${payload}.${encode(new Uint8Array(signature))}` };
    }

    async function credentials(response) {
      if (!response.ok) throw new Error("connection unavailable... /ᐠ - ˕ -マ");
      const value = await response.json();
      if (value.protocol !== 2 || !Number.isSafeInteger(value.expires) || typeof value.backend !== "string" ||
          [value.access, value.refresh, value.nonce].some((entry) => typeof entry !== "string" || !/^[\w-]{43}$/.test(entry))) {
        throw new Error("connection unavailable... /ᐠ - ˕ -マ");
      }
      return value;
    }

    function current(force) {
      if (!force && session && session.credentials.expires - Date.now() > 30_000) return Promise.resolve(session);
      return renewing ??= (async () => {
        if (session) {
          const response = await request("refresh", { method: "POST",
            headers: await proof(session, "refresh", session.credentials.refresh) });
          if (response.status !== 401) return (session = { ...session, credentials: await credentials(response) });
          session = null;
        }
        const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
        const response = await request("start", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jwk }) });
        return (session = { key: pair.privateKey, jwk, credentials: await credentials(response) });
      })().finally(() => { renewing = null; });
    }

    async function ticket(retry = true) {
      const active = await current(false);
      const response = await request("nuru", { method: "POST", headers: await proof(active, "nuru", active.credentials.access) });
      if (response.status === 401 && retry) {
        await current(true);
        return ticket(false);
      }
      if (!response.ok) throw new Error("connection unavailable... /ᐠ - ˕ -マ");
      const value = await response.json();
      if (typeof value.ticket !== "string" || !/^auth\.[\w.-]{1,200}$/.test(value.ticket)) {
        throw new Error("connection unavailable... /ᐠ - ˕ -マ");
      }
      return value.ticket;
    }

    return { available, ticket };
  }

  const tickets = () => globalThis[Symbol.for("lyra.nuruTickets")] ??= nuruTickets();

  return class extends EventTarget {
    static [Symbol.for("lyra.nuruSocket")] = true;
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    socket = null;
    state = 0;
    type = "blob";
    constructor(url, protocols) {
      super();
      const target = new URL(String(url), globalThis.location.href);
      if (!/^wss?:$/.test(target.protocol) || target.host !== globalThis.location.host || target.pathname !== wispPath) {
        return new NativeWebSocket(url, protocols);
      }
      this.url = target.href;
      void this.open(protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols]);
    }
    async open(protocols) {
      try {
        if (await tickets().available()) protocols.push(await tickets().ticket());
        if (this.state !== 0) return;
        const socket = this.socket = new NativeWebSocket(this.url, protocols);
        socket.binaryType = this.type;
        for (const name of ["open", "message", "error", "close"]) socket.addEventListener(name, (event) => {
          this.state = socket.readyState;
          const copy = name === "message" ? new MessageEvent(name, { data: event.data, origin: event.origin }) :
            name === "close" ? new CloseEvent(name, { code: event.code, reason: event.reason, wasClean: event.wasClean }) : new Event(name);
          this.dispatchEvent(copy);
          this[`on${name}`]?.call(this, copy);
        });
      } catch {
        if (this.state !== 0) return;
        this.state = 3;
        for (const event of [new Event("error"), new CloseEvent("close", { code: 1006 })]) {
          this.dispatchEvent(event);
          this[`on${event.type}`]?.call(this, event);
        }
      }
    }
    get readyState() { return this.socket?.readyState ?? this.state; }
    get bufferedAmount() { return this.socket?.bufferedAmount ?? 0; }
    get protocol() { return this.socket?.protocol.startsWith("auth.") ? "" : this.socket?.protocol ?? ""; }
    get extensions() { return this.socket?.extensions ?? ""; }
    get binaryType() { return this.type; }
    set binaryType(value) { this.type = value; if (this.socket) this.socket.binaryType = value; }
    send(data) {
      if (!this.socket || this.readyState !== 1) throw new DOMException("connection is unavailable... /ᐠ - ˕ -マ", "InvalidStateError");
      this.socket.send(data);
    }
    close(code, reason) {
      if (this.state === 3) return;
      this.state = 3;
      if (this.socket) this.socket.close(code, reason);
      else queueMicrotask(() => {
        const event = new CloseEvent("close", { code: 1000, wasClean: true });
        this.dispatchEvent(event);
        this.onclose?.call(this, event);
      });
    }
  };
}
