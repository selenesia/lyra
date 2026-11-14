import { StaticAuth, isStaticOrigin, STATIC_PREFIX, STATIC_PROTOCOL } from "./static-auth.mjs";

const NEGATIVE = "... /ᐠ - ˕ -マ";
const RELAY_PROTOCOL = "relay-v1";
const TICKET_PREFIX = "ticket.";
const BODY_LIMIT = 10 * 1024 * 1024;
const FRAME_LIMIT = 1024 * 1024;
const BUFFER_LIMIT = 4 * 1024 * 1024;
const requestHeaders = new Set([
  "accept", "accept-language", "content-type", "range", "if-range", "if-none-match",
  "if-modified-since", "cache-control", "x-mochi-folio-headers", "x-mochi-folio-session",
  "x-mochi-folio-rewrite",
]);
const corsHeaders = new Set([...requestHeaders, "authorization", "dpop"]);
const responseHeaders = new Set([
  "content-type", "content-range", "accept-ranges", "etag", "last-modified",
  "retry-after", "x-mochi-upstream-meta", "x-mochi-cache", "x-mochi-folio-cache",
  "x-error-class", "content-length",
]);
const readMethods = new Set(["GET", "HEAD"]);
const proxyMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function staticRoute(pathname, method) {
  if (proxyMethods.has(method) && /^\/(?:!!|!!raw|!!folio\/request)\/.+$/.test(pathname)) {
    return !pathname.includes("\\") && !/%00/i.test(pathname);
  }
  if (pathname.includes("\\") || pathname.includes("//") || /%(?:00|2e|2f|5c)/i.test(pathname)) return false;
  if (readMethods.has(method)) {
    if (/^\/api\/(?:dns|presence|search\/suggestions)$/.test(pathname)) return true;
    if (/^\/api\/anime\/(?:episodes(?:\/\d+)?|relations\/\d+|alttitles\/\d+)$/.test(pathname)) return true;
    if (/^\/api\/watch\/(?:home|discover|search|details|season)$/.test(pathname)) return true;
    if (/^\/stream\/(?:info|anikoto(?:\/(?:variant|resource|track))?|watch\/(?:playlist|variant|resource|track)|s-2\/[^/]+)$/.test(pathname)) return true;
    if (pathname === "/!!folio/capabilities" || /^\/!cover!\/.+$/.test(pathname)) return true;
  }
  if (method === "POST" && /^\/api\/(?:notice|anime\/(?:identity\/resolve|resolve-stream))$/.test(pathname)) return true;
  return false;
}

async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  let timeout;
  try {
    await Promise.race([(async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        size += value.byteLength;
        if (size > 16 * 1024) throw new Error();
        chunks.push(value);
      }
    })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error()), 10_000); })]);
    const value = JSON.parse(Buffer.concat(chunks).toString());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { void reader.cancel().catch(() => {}); return null; }
  finally { clearTimeout(timeout); }
}

export function createStaticGateway({ backend = "",
  forward, metadata = () => ({}), wispUpstream, nuruTicket = null, sessions, starts, idle, now = Date.now }) {
  const auth = new StaticAuth({ backend, now, sessions, starts, idle });
  function requestBackend(request) {
    if (auth.backend) return auth.backend;
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.protocol = "https:";
    return url.origin;
  }
  let active = 0;
  const activeIps = new Map();
  let activeSockets = 0;
  const socketIps = new Map();
  const socketSubjects = new Map();
  let controls = 0;
  const controlIps = new Map();
  let lastSweep = 0;

  function headers(origin) {
    const result = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff", "vary": "Origin, Authorization" });
    if (isStaticOrigin(origin)) {
      result.set("access-control-allow-origin", origin);
      result.set("access-control-expose-headers", [...responseHeaders, "x-static-auth"].join(", "));
    }
    return result;
  }

  function json(value, status = 200, origin = "") {
    return Response.json(value, { status, headers: headers(origin) });
  }

  function error(status, origin = "", code = "static_request_rejected") {
    const response = json({ error: `connection request is unavailable${NEGATIVE}`, code }, status, origin);
    if (status === 401) response.headers.set("x-static-auth", "required");
    return response;
  }

  async function http(request, session, target, ip, origin) {
    if (active >= 128 || session.requests >= 32 || (activeIps.get(ip) || 0) >= 64) return error(429, origin);
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return error(413, origin);
    const outgoing = new Headers();
    for (const [name, value] of request.headers) if (requestHeaders.has(name)) outgoing.set(name, value);
    outgoing.set("accept-encoding", "identity");
    outgoing.set("x-forwarded-for", ip);
    outgoing.set("x-real-ip", ip);
    if (target.startsWith("/!!folio/request/")) {
      outgoing.set("x-mochi-folio-session", session.id);
    }
    active++;
    session.requests++;
    activeIps.set(ip, (activeIps.get(ip) || 0) + 1);
    const controller = new AbortController();
    let reader;
    let released = false;
    let handedOff = false;
    let oversize = false;
    let expiry;
    const aborted = () => { controller.abort(); void reader?.cancel().catch(() => {}); release(); };
    const timeout = setTimeout(aborted, 70_000);
    const release = () => {
      if (released) return;
      released = true;
      active--;
      session.requests--;
      const count = (activeIps.get(ip) || 1) - 1;
      if (count) activeIps.set(ip, count); else activeIps.delete(ip);
      clearTimeout(timeout);
      clearTimeout(expiry);
      session.streams.delete(aborted);
      request.signal.removeEventListener("abort", aborted);
    };
    request.signal.addEventListener("abort", aborted, { once: true });
    session.streams.add(aborted);
    expiry = setTimeout(aborted, Math.max(1, session.expires - now()));
    if (request.signal.aborted) aborted();
    let body;
    if (!readMethods.has(request.method) && request.body) {
      let size = 0;
      body = request.body.pipeThrough(new TransformStream({
        transform(chunk, stream) {
          size += chunk.byteLength;
          if (size > BODY_LIMIT) {
            oversize = true;
            controller.abort();
            stream.error(new Error(`request body is too large${NEGATIVE}`));
          } else stream.enqueue(chunk);
        },
      }));
    }
    try {
      let response = await forward(target, { method: request.method, headers: outgoing, body,
        redirect: "manual", signal: controller.signal });
      clearTimeout(timeout);
      if (target.startsWith("/!!/") && /\btext\/html\b/i.test(response.headers.get("content-type") || "")) {
        const base = session.base;
        const script = `<script src="${base}__static/socket.js"></script>`;
        response = new HTMLRewriter()
          .on("head", { element(element) { element.prepend(script, { html: true }); } })
          .on("[href], [src], [action], [poster], [data], [formaction]", { element(element) {
            for (const attribute of ["href", "src", "action", "poster", "data", "formaction"]) {
              const value = element.getAttribute(attribute);
              if (value?.startsWith("/!!/")) element.setAttribute(attribute, base + value.slice(1));
            }
          } }).transform(response);
        response.headers.delete("content-length");
      }
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel();
        return error(502, origin);
      }
      const resultHeaders = headers(origin);
      for (const [name, value] of response.headers) {
        if (!responseHeaders.has(name)) continue;
        if (name === "content-length" && (response.headers.has("content-encoding") || !/^\d+$/.test(value))) continue;
        resultHeaders.set(name, value);
      }
      if (!/^\/api\/(?:auth|sync)\//.test(target)) {
        const cache = response.headers.get("cache-control");
        if (cache) {
          const directives = cache.split(",").map((value) => value.trim())
            .filter((value) => value && !/^(?:public|private)(?:\s*=|$)|^s-maxage\s*=/i.test(value));
          resultHeaders.set("cache-control", ["private", ...directives].join(", "));
        }
      }
      if (request.method === "HEAD" || !response.body) {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: resultHeaders });
      }
      reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(streamController) {
          try {
            if (!auth.active(session)) throw new Error();
            const { done, value } = await reader.read();
            if (done) { release(); streamController.close(); }
            else streamController.enqueue(value);
          } catch {
            aborted(); release();
            streamController.error(new Error(`connection ended${NEGATIVE}`));
          }
        },
        async cancel() { aborted(); release(); await reader.cancel().catch(() => {}); },
      });
      handedOff = true;
      return new Response(stream, { status: response.status, headers: resultHeaders });
    } catch { return error(oversize ? 413 : 502, origin); }
    finally { if (!handedOff) release(); }
  }

  async function routeRequest(request, { ip, server }) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(STATIC_PREFIX)) return null;
    const route = url.pathname.slice(STATIC_PREFIX.length);
    const origin = request.headers.get("origin") || "";
    const method = request.method;
    if (route === "status" && method === "GET") {
      if (origin && !isStaticOrigin(origin)) return error(403);
      return json({ protocol: STATIC_PROTOCOL, enabled: true, nuru: Boolean(nuruTicket) }, 200, origin);
    }
    if (!auth.limit(`gateway:${ip}`, 2400)) return error(429, origin);
    if (!isStaticOrigin(origin)) return error(403);
    const backendOrigin = requestBackend(request);
    const wisp = `${backendOrigin.replace(/^http/, "ws")}${STATIC_PREFIX}socket/`;
    const target = route.startsWith("http/") ? `/${route.slice(5)}` : null;
    const requestedMethod = method === "OPTIONS" && request.headers.has("access-control-request-method")
      ? request.headers.get("access-control-request-method") : method;
    const control = { start: "POST", refresh: "POST", revoke: "POST", ticket: "POST", nuru: "POST", metadata: "GET", "socket/": "GET" };
    if (target ? !staticRoute(target, requestedMethod) : control[route] !== requestedMethod) return error(404, origin);
    if (method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      const requested = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((name) => name.trim()).filter(Boolean);
      if (requested.some((name) => !corsHeaders.has(name))) return error(403, origin);
      const result = headers(origin);
      result.set("access-control-allow-methods", requestedMethod);
      result.set("access-control-allow-headers", requested.join(", "));
      result.set("access-control-max-age", "600");
      result.set("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      return new Response(null, { status: 204, headers: result });
    }
    if (route === "start") {
      const body = await jsonBody(request);
      if (!body) return error(400, origin);
      const result = await auth.start(origin, body, ip, backendOrigin);
      return result ? json(result, 200, origin) : error(401, origin);
    }
    if (route === "socket/") return upgrade(request, { ip, server, origin });
    const session = await auth.authorize(request, route === "refresh", backendOrigin);
    if (!session) return error(401, origin);
    if (route === "refresh") return json(auth.issue(session), 200, origin);
    if (route === "revoke") {
      auth.revoke(session);
      return json({ success: true, user: null, error: null }, 200, origin);
    }
    if (route === "metadata") return json({ ...await metadata(backendOrigin), protocol: STATIC_PROTOCOL, wisp }, 200, origin);
    if (route === "nuru") {
      if (!nuruTicket) return error(404, origin);
      return auth.limit(`nuru:${ip}`, 120) ? json(nuruTicket(), 200, origin) : error(429, origin);
    }
    if (route === "ticket") {
      const body = await jsonBody(request);
      if (!body || Object.keys(body).some((name) => name !== "path")) return error(400, origin);
      const path = body.path ?? null;
      if (path !== null && (typeof path !== "string" || path.length > 8192 || !path.startsWith("/!!/") ||
          /[\\\s#]/.test(path) || new URL(path, backendOrigin).pathname !== path.split("?")[0])) return error(400, origin);
      const ticket = auth.ticket(session, ip, path);
      return ticket ? json({ ticket, wisp }, 200, origin) : error(429, origin);
    }
    return http(request, session, target + url.search, ip, origin);
  }

  async function handle(request, { ip = "unknown", server } = {}) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith(STATIC_PREFIX)) return null;
    if (now() - lastSweep >= 60_000) { auth.sweep(); lastSweep = now(); }
    const control = pathname === STATIC_PREFIX + "start";
    const origin = request.headers.get("origin") || "";
    if (control && (controls >= 64 || (controlIps.get(ip) || 0) >= 4)) return error(429, origin);
    if (control) { controls++; controlIps.set(ip, (controlIps.get(ip) || 0) + 1); }
    try { return await routeRequest(request, { ip, server }); }
    catch { return error(503, origin); }
    finally {
      if (control) {
        controls--;
        const count = (controlIps.get(ip) || 1) - 1;
        if (count) controlIps.set(ip, count); else controlIps.delete(ip);
      }
    }
  }

  async function upgrade(request, { ip, server, origin }) {
    if (!server || !wispUpstream || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(400, origin);
    const protocols = (request.headers.get("sec-websocket-protocol") || "").split(",").map((value) => value.trim());
    const tickets = protocols.filter((value) => value.startsWith(TICKET_PREFIX));
    const actual = protocols.filter((value) => !value.startsWith(TICKET_PREFIX) && value !== RELAY_PROTOCOL);
    if (protocols.filter((value) => value === RELAY_PROTOCOL).length !== 1 || tickets.length !== 1 || actual.length > 8 || new Set(actual).size !== actual.length ||
        actual.some((value) => !/^[!#$%&'*+.^_`|~\w-]{1,128}$/.test(value))) return error(400, origin);
    const claim = await auth.consumeTicket(tickets[0].slice(TICKET_PREFIX.length), origin, ip);
    const session = claim?.session;
    const backendOrigin = requestBackend(request);
    if (!session || session.backend !== backendOrigin || session.sockets.size >= 4) return error(401, origin);
    if (!claim.path && (actual.length > 1 || actual.some((value) => value !== "wisp"))) return error(400, origin);
    if (activeSockets >= 128 || (socketIps.get(ip) || 0) >= 16 || (socketSubjects.get(session.subject) || 0) >= 8) return error(429, origin);
    activeSockets++;
    socketIps.set(ip, (socketIps.get(ip) || 0) + 1);
    socketSubjects.set(session.subject, (socketSubjects.get(session.subject) || 0) + 1);
    const connection = { session, ip, upstream: null, client: null, closed: false, queued: 0, expiry: null,
      close(code = 1008) {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.expiry);
        session.sockets.delete(this);
        activeSockets--;
        for (const [map, key] of [[socketIps, ip], [socketSubjects, session.subject]]) {
          const count = (map.get(key) || 1) - 1;
          if (count) map.set(key, count); else map.delete(key);
        }
        this.client?.close(code, `connection ended${NEGATIVE}`);
        this.upstream?.close(code, `connection ended${NEGATIVE}`);
      } };
    session.sockets.add(connection);
    let phase = "target";
    try {
      const target = await wispUpstream({ path: claim.path });
      phase = "handshake";
      const upstreamHeaders = { origin: backendOrigin, host: new URL(backendOrigin).host, "x-real-ip": ip, "x-forwarded-for": ip };
      const upstreamProtocols = !claim.path && nuruTicket ? [...actual, nuruTicket().ticket] : actual;
      if (upstreamProtocols.length) upstreamHeaders["sec-websocket-protocol"] = upstreamProtocols.join(", ");
      const upstream = new WebSocket(target, { headers: upstreamHeaders });
      connection.upstream = upstream;
      upstream.binaryType = "arraybuffer";
      upstream.pause();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error()), 10_000);
        upstream.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
        upstream.addEventListener("error", () => { clearTimeout(timeout); reject(new Error()); }, { once: true });
        upstream.addEventListener("close", () => { clearTimeout(timeout); reject(new Error()); }, { once: true });
      });
      phase = "session";
      if (!auth.active(session) || connection.closed) { connection.close(); return error(401, origin); }
      upstream.addEventListener("message", (event) => {
        const bytes = typeof event.data === "string" ? Buffer.byteLength(event.data) : event.data.byteLength;
        if (bytes > FRAME_LIMIT || connection.queued + bytes > BUFFER_LIMIT) { connection.close(1009); return; }
        connection.queued += bytes;
        connection.receiving = (connection.receiving || Promise.resolve()).then(async () => {
          if (connection.closed || !auth.active(session)) { connection.close(); return; }
          const sent = connection.client?.send(event.data);
          if (sent === 0 || sent === undefined) connection.close();
          else if (sent === -1) upstream.pause();
        }).catch(() => connection.close()).finally(() => { connection.queued -= bytes; });
      });
      upstream.addEventListener("error", () => connection.close(1011));
      upstream.addEventListener("close", () => connection.close(1000));
      const selected = upstream.protocol.startsWith("auth.") ? "" : upstream.protocol;
      phase = "upgrade";
      if (selected && !actual.includes(selected)) { connection.close(); return error(502, origin); }
      const responseHeaders = new Headers({ "sec-websocket-protocol": selected || RELAY_PROTOCOL });
      if (!server.upgrade(request, { headers: responseHeaders, data: { staticConnection: connection } })) {
        connection.close(); return error(400, origin);
      }
      connection.expiry = setTimeout(() => connection.close(), Math.max(1, session.expires - now()));
      return undefined;
    } catch { console.warn(`static socket connection failed at ${phase}${NEGATIVE}`); connection.close(1011); return error(502, origin); }
  }

  const websocket = {
    maxPayloadLength: FRAME_LIMIT, backpressureLimit: BUFFER_LIMIT, closeOnBackpressureLimit: true,
    perMessageDeflate: false, idleTimeout: 60,
    open(socket) {
      const connection = socket.data.staticConnection;
      if (!connection) return;
      connection.client = socket;
      if (connection.closed) socket.close(1008); else connection.upstream.resume();
    },
    message(socket, message) {
      const connection = socket.data.staticConnection;
      if (!connection || connection.closed) return;
      const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
      if (size > FRAME_LIMIT || (connection.sendingBytes || 0) + size > BUFFER_LIMIT) { connection.close(1009); return; }
      connection.sendingBytes = (connection.sendingBytes || 0) + size;
      connection.sending = (connection.sending || Promise.resolve()).then(async () => {
        if (connection.closed || !auth.active(connection.session) || connection.upstream.readyState !== WebSocket.OPEN
          || connection.upstream.bufferedAmount + size > BUFFER_LIMIT) { connection.close(); return; }
        connection.upstream.send(message);
      }).catch(() => connection.close()).finally(() => { connection.sendingBytes -= size; });
    },
    drain(socket) { socket.data.staticConnection?.upstream.resume(); },
    close(socket) { socket.data.staticConnection?.close(1000); },
  };
  return { auth, handle, websocket };
}
