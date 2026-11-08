import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const STATIC_PROTOCOL = 2;
export const STATIC_PREFIX = "/api/static/v1/";
const ACCESS_MS = 10 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const PROOF_MS = 60_000;
const negative = "... /ᐠ - ˕ -マ";
const token = () => randomBytes(32).toString("base64url");
export const digest = (value) => createHash("sha256").update(value).digest("base64url");
const equal = (a, b) => typeof a === "string" && typeof b === "string" &&
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function isStaticOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

function publicKey(jwk) {
  if (!jwk || Object.keys(jwk).some((key) => !["kty", "crv", "x", "y", "ext", "key_ops", "alg"].includes(key)) ||
      jwk.kty !== "EC" || jwk.crv !== "P-256" ||
      !/^[\w-]{43}$/.test(jwk.x) || !/^[\w-]{43}$/.test(jwk.y)) throw new Error(`invalid signing key${negative}`);
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function thumbprint(jwk) {
  return digest(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

export class StaticAuth {
  constructor({ backend = "", now = Date.now, sessions = 2_000, starts = 60, idle = 0 }) {
    this.backend = backend ? new URL(backend).origin : "";
    this.now = now;
    this.capacity = sessions;
    this.starts = starts;
    this.idle = idle;
    this.access = new Map();
    this.refresh = new Map();
    this.tickets = new Map();
    this.sessions = new Set();
    this.subjects = new Map();
    this.limits = new Map();
  }

  sweep() {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    for (const session of this.sessions) if (session.expires <= now || this.idled(session, now)) this.revoke(session);
    for (const [id, limit] of this.limits) if (limit.expires <= now) this.limits.delete(id);
  }

  idled(session, now) {
    return this.idle > 0 && now - session.seen >= this.idle && !session.sockets.size && !session.streams.size;
  }

  limit(id, maximum, window = 60_000) {
    const now = this.now();
    let limit = this.limits.get(id);
    if (!limit || limit.expires <= now) {
      if (!limit && this.limits.size >= this.capacity * 10) return false;
      limit = { count: 0, expires: now + window };
      this.limits.set(id, limit);
    }
    return ++limit.count <= maximum;
  }

  async start(origin, body, ip, backend = this.backend) {
    if (this.sessions.size >= this.capacity) this.sweep();
    if (!isStaticOrigin(origin) || !isStaticOrigin(backend) || !this.limit(`start:${ip}`, this.starts, 5 * 60_000) ||
        this.sessions.size >= this.capacity || !body || Object.keys(body).some((name) => !["jwk", "base"].includes(name))) return null;
    const base = body.base === undefined ? "/" : body.base;
    if (typeof base !== "string" || base.length > 1024 || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) return null;
    try {
      const jwk = publicKey(body.jwk);
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      if (this.sessions.size >= this.capacity || (this.subjects.get(ip) || 0) >= 256) return null;
      const session = { id: token(), origin, base, backend, key, thumb: thumbprint(jwk), subject: ip,
        expires: this.now() + SESSION_MS, seen: this.now(), nonce: token(), proofs: new Map(),
        sockets: new Set(), streams: new Set(), requests: 0 };
      this.sessions.add(session);
      this.subjects.set(ip, (this.subjects.get(ip) || 0) + 1);
      return this.issue(session);
    } catch { return null; }
  }

  issue(session) {
    if (session.access) this.access.delete(digest(session.access));
    if (session.refresh) this.refresh.delete(digest(session.refresh));
    session.access = token();
    session.refresh = token();
    session.accessExpires = Math.min(this.now() + ACCESS_MS, session.expires);
    this.access.set(digest(session.access), session);
    this.refresh.set(digest(session.refresh), session);
    return { access: session.access, refresh: session.refresh, nonce: session.nonce,
      expires: session.accessExpires, protocol: STATIC_PROTOCOL, backend: session.backend };
  }

  async proof(request, session, credential) {
    try {
      const serialized = request.headers.get("dpop") || "";
      if (serialized.length > 2048) return false;
      const parts = serialized.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[\w-]+$/.test(part))) return false;
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      const jwk = publicKey(header.jwk);
      const url = new URL(request.url);
      url.search = "";
      url.hash = "";
      const now = this.now();
      if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || header.crit ||
          thumbprint(jwk) !== session.thumb || payload.htm !== request.method ||
          payload.htu !== `${session.backend}${url.pathname}` ||
          !Number.isInteger(payload.iat) || Math.abs(now - payload.iat * 1000) > PROOF_MS ||
          !/^[\w-]{20,128}$/.test(payload.jti) || !equal(payload.ath, digest(credential)) ||
          !equal(payload.nonce, session.nonce)) return false;
      const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, session.key,
        Buffer.from(parts[2], "base64url"), Buffer.from(`${parts[0]}.${parts[1]}`));
      if (!valid) return false;
      for (const [id, expiry] of session.proofs) if (expiry <= now) session.proofs.delete(id);
      if (session.proofs.has(payload.jti) || session.proofs.size >= 4_000) return false;
      session.proofs.set(payload.jti, now + 2 * PROOF_MS);
      return true;
    } catch { return false; }
  }

  active(session) {
    return this.sessions.has(session) && session.expires > this.now();
  }

  async authorize(request, refresh = false, backend = this.backend) {
    const authorization = request.headers.get("authorization") || "";
    if (!/^DPoP [\w-]{43}$/.test(authorization)) return null;
    const credential = authorization.slice(5);
    const session = (refresh ? this.refresh : this.access).get(digest(credential));
    if (!session || session.backend !== backend || request.headers.get("origin") !== session.origin ||
        session.expires <= this.now() || (!refresh && session.accessExpires <= this.now()) ||
        !this.limit(`session:${session.id}`, 2_000) ||
        !await this.proof(request, session, credential) || !this.active(session)) return null;
    if ((refresh ? this.refresh : this.access).get(digest(credential)) !== session) return null;
    session.seen = this.now();
    return session;
  }

  ticket(session, ip, path = null) {
    if (this.tickets.size >= 4_000) this.sweep();
    if (!this.sessions.has(session) || session.sockets.size >= 4 || this.tickets.size >= 4_000 ||
        !this.limit(`ticket:${ip}`, 60)) return null;
    const value = token();
    this.tickets.set(digest(value), { session, ip, path, expires: this.now() + 15_000 });
    return value;
  }

  async consumeTicket(value, origin, ip) {
    if (!/^[\w-]{43}$/.test(value || "")) return null;
    const key = digest(value);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (!ticket || ticket.expires <= this.now() || ticket.ip !== ip ||
        ticket.session.origin !== origin || ticket.session.sockets.size >= 4 ||
        !this.active(ticket.session)) return null;
    return ticket;
  }

  revoke(session) {
    this.access.delete(digest(session.access));
    this.refresh.delete(digest(session.refresh));
    if (this.sessions.delete(session)) {
      const count = (this.subjects.get(session.subject) || 1) - 1;
      if (count) this.subjects.set(session.subject, count); else this.subjects.delete(session.subject);
    }
    for (const [key, ticket] of this.tickets) if (ticket.session === session) this.tickets.delete(key);
    for (const socket of session.sockets) socket.close(1008, `authorization ended${negative}`);
    session.sockets.clear();
    for (const abort of session.streams) abort();
    session.streams.clear();
  }
}
