function staticSocketClass(NativeWebSocket) {
  if (NativeWebSocket[Symbol.for("lyra.staticSocket")]) return NativeWebSocket;
  return class extends EventTarget {
    static [Symbol.for("lyra.staticSocket")] = true;
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
    closing = false;
    constructor(url, protocols = []) {
      super();
      this.url = String(url);
      const base = "__STATIC_BASE__";
      const backendSocket = globalThis.__LYRA_BACKEND__.replace(/^http/, "ws") + "/api/static/v1/socket/";
      const workerOrigin = globalThis.__LYRA_WORKER_ORIGIN__ || globalThis.location.origin;
      const target = new URL(this.url, globalThis.__LYRA_WORKER_BASE__ || globalThis.location.href);
      const localProxy = target.host === new URL(workerOrigin).host && /^wss?:$/.test(target.protocol) && target.pathname.startsWith(base + "!!/");
      if (!localProxy && this.url !== backendSocket) return new NativeWebSocket(url, protocols);
      void this.open(protocols, localProxy ? "/" + target.pathname.slice(base.length) + target.search : null, backendSocket);
    }
    async open(protocols, path, backendSocket) {
      try {
        const origin = globalThis.__LYRA_WORKER_ORIGIN__ || globalThis.location.origin;
        const response = await globalThis.fetch(new URL("__STATIC_BASE____static/ticket", origin), { method: "POST", cache: "no-store",
          headers: { "content-type": "application/json" }, body: JSON.stringify(path ? { path } : {}) });
        if (!response.ok) throw new Error();
        const { ticket } = await response.json();
        if (this.state !== 0) return;
        if (!/^[\w-]{43}$/.test(ticket)) throw new Error();
        const offered = typeof protocols === "string" ? [protocols] : protocols;
        const socket = this.socket = new NativeWebSocket(backendSocket, [...offered, "relay-v1", `ticket.${ticket}`]);
        socket.binaryType = this.type;
        for (const name of ["open", "message", "error", "close"]) socket.addEventListener(name, (event) => {
          if (name === "open") this.opened = true;
          if (name === "close" && this.opened && !this.closing && !path) {
            void globalThis.fetch(new URL("__STATIC_BASE____static/recover", origin), { method: "POST", cache: "no-store" }).catch(() => {});
          }
          this.state = socket.readyState;
          const copy = name === "message" ? new MessageEvent(name, { data: event.data, origin: event.origin }) :
            name === "close" ? new CloseEvent(name, { code: event.code, reason: event.reason, wasClean: event.wasClean }) : new Event(name);
          this.dispatchEvent(copy);
          this[`on${name}`]?.call(this, copy);
        });
      } catch {
        this.state = 3;
        for (const event of [new Event("error"), new CloseEvent("close", { code: 1006 })]) {
          this.dispatchEvent(event);
          this[`on${event.type}`]?.call(this, event);
        }
      }
    }
    get readyState() { return this.socket?.readyState ?? this.state; }
    get bufferedAmount() { return this.socket?.bufferedAmount ?? 0; }
    get protocol() { return this.socket?.protocol === "relay-v1" ? "" : this.socket?.protocol ?? ""; }
    get extensions() { return this.socket?.extensions ?? ""; }
    get binaryType() { return this.type; }
    set binaryType(value) { this.type = value; if (this.socket) this.socket.binaryType = value; }
    send(data) {
      if (!this.socket || this.readyState !== 1) throw new DOMException("connection is unavailable... /ᐠ - ˕ -マ", "InvalidStateError");
      this.socket.send(data);
    }
    close(code, reason) {
      if (this.state === 3) return;
      this.closing = true;
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
