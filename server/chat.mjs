import { randomBytes } from "crypto";
import { httpError } from "./errors.mjs";
import { ChatAuthUnavailable } from "./chat-auth.mjs";
import { PERMANENT } from "./chat-store.mjs";
import { readChatImage } from "./chat-media.mjs";
import { blockedNotice, moderate } from "../src/features/chat/moderation.ts";
import {
  CHAT_CHANNELS,
  CHAT_LIMITS,
  CHAT_MEDIA,
  CHAT_MEDIA_TYPES,
  CHAT_PROFILE_TEXT,
  canPostIn,
  cleanChatText,
  cleanProfileText,
  isChatAccent,
  isChatChannel,
  isChatReaction,
  replySnippet,
} from "../src/features/chat/chatProtocol.ts";
import {
  assignableRoles,
  canBan,
  canDeleteAny,
  canTimeout,
  isChatRole,
  outranks,
  roleRank,
} from "../src/features/chat/chatRoles.ts";

const BODY_MAX_BYTES = 4096;
const PURGE_WINDOW_MS = 24 * 60 * 60_000;
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const NAME_CACHE_LIMIT = 2_000;
const MEDIA_ROUTE = /^media\/(avatar|banner)(?:\/(\d{1,15}))?$/;
const PROFILE_LABELS = { display: "display name", pronouns: "pronouns", status: "status", bio: "bio" };

async function readBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error();
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch {
    void reader.cancel().catch(() => {});
    return null;
  }
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return null;
  const body = await readBody(request, BODY_MAX_BYTES);
  if (!body) return null;
  try {
    const payload = JSON.parse(body.toString());
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function crossSite(request) {
  return ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site"));
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const reply = (failure) => json(failure.status, failure.body);
const ok = (body = { ok: true }) => ({ status: 200, body });

export function createChatRoom({
  store,
  identify,
  checkImage = async () => ({ unavailable: true }),
  historySize = CHAT_LIMITS.page,
  maxStreamsPerUser = 8,
  pingMs = 20_000,
  presenceDelayMs = 250,
  sendLimit = 5,
  sendWindowMs = 8_000,
  sourceSendLimit = 30,
  reactLimit = 12,
  typingGapMs = 1_500,
  strikeLimit = 3,
  strikeDecayMs = 5 * 60_000,
  muteMs = 2 * 60_000,
  maxMuteMs = 60 * 60_000,
  duplicateMs = 30_000,
  profileLimit = 8,
  profileWindowMs = 60_000,
  now = Date.now,
} = {}) {
  const encoder = new TextEncoder();
  const pingFrame = encoder.encode(": ping\n\n");
  const streams = new Map();
  const activity = new Map();
  const sourceSends = new Map();
  const nameVerdicts = new Map();
  const uploading = new Set();
  let heartbeat;
  let presenceTimer;

  const frame = (event, value) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  const member = (row) => ({
    author: String(row.id),
    name: row.username,
    role: row.role,
    ...(row.display && { display: row.display }),
    ...(row.avatar_hash && { avatar: row.avatar_hash }),
    ...(row.status && { status: row.status }),
  });
  const streamUser = (row) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    display: row.display,
    avatar_hash: row.avatar_hash,
    status: row.status,
  });

  function broadcast(bytes) {
    for (const stream of streams.values()) stream.send(bytes);
  }

  function sendTo(userId, bytes) {
    for (const stream of streams.values()) if (stream.user.id === userId) stream.send(bytes);
  }

  function members() {
    const byUser = new Map();
    for (const stream of streams.values()) byUser.set(stream.user.id, stream.user);
    return [...byUser.values()]
      .sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.username.localeCompare(b.username))
      .map(member);
  }

  function announcePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      broadcast(frame("members", members()));
    }, presenceDelayMs);
    presenceTimer.unref?.();
  }

  function viewer(row) {
    return { ...member(row), ...(row.muted_until > now() && { mutedUntil: row.muted_until }) };
  }

  function nameAllowed(username) {
    let verdict = nameVerdicts.get(username);
    if (!verdict) {
      if (nameVerdicts.size >= NAME_CACHE_LIMIT) nameVerdicts.clear();
      verdict = moderate(username);
      nameVerdicts.set(username, verdict);
    }
    return verdict.allowed || verdict.strikes < 2;
  }

  async function session(request, ip) {
    let identity;
    try {
      identity = await identify(request, ip);
    } catch (error) {
      if (!(error instanceof ChatAuthUnavailable)) throw error;
      return { failure: httpError(503, "CHAT_AUTH_UNAVAILABLE", "chat login check is unavailable right now") };
    }
    if (!identity) return { failure: httpError(401, "CHAT_LOGIN_REQUIRED", "log in to use chat") };
    const row = store.identify(identity, now());
    if (row.banned_until > now()) {
      return {
        failure: httpError(403, "CHAT_BANNED", "you are banned from chat", {
          ...(row.banned_until < PERMANENT && { until: row.banned_until }),
          ...(row.ban_reason && { reason: row.ban_reason }),
        }),
      };
    }
    if (!nameAllowed(row.username)) {
      return { failure: httpError(403, "CHAT_USERNAME_BLOCKED", "your username is not allowed in chat") };
    }
    return { row };
  }

  function activityOf(userId, time) {
    let entry = activity.get(userId);
    if (!entry) {
      entry = { sends: [], reacts: [], profiles: [], typedAt: 0, last: undefined };
      activity.set(userId, entry);
    }
    entry.sends = entry.sends.filter((at) => time - at < sendWindowMs);
    entry.reacts = entry.reacts.filter((at) => time - at < sendWindowMs);
    entry.profiles = entry.profiles.filter((at) => time - at < profileWindowMs);
    return entry;
  }

  function sourceWindow(ip, time) {
    const list = (sourceSends.get(ip) || []).filter((at) => time - at < sendWindowMs);
    if (list.length) sourceSends.set(ip, list);
    else sourceSends.delete(ip);
    if (sourceSends.size > 10_000) sourceSends.clear();
    return list;
  }

  function strike(row, points, time) {
    if (!points) return 0;
    const steps = Math.floor((time - row.strike_updated) / strikeDecayMs);
    let current = Math.max(0, row.strike_points - Math.max(0, steps)) + points;
    let mutes = row.mute_count;
    let mutedUntil = row.muted_until;
    if (current >= strikeLimit) {
      mutedUntil = time + Math.min(maxMuteMs, muteMs * 2 ** mutes);
      mutes += 1;
      current = 0;
      sendTo(row.id, frame("muted", { until: mutedUntil }));
    }
    store.setStrikes(row.id, { points: current, updated: time, mutes, mutedUntil });
    return mutedUntil > time ? mutedUntil : 0;
  }

  function rejectContent(row, verdict, time) {
    const until = strike(row, verdict.strikes, time);
    return httpError(422, "CHAT_MESSAGE_BLOCKED", blockedNotice("message", verdict.category), {
      category: verdict.category,
      ...(until && { until }),
    });
  }

  function readText(payload, row, time) {
    const text = cleanChatText(payload.text);
    if (!text) return { failure: httpError(400, "CHAT_TEXT_INVALID", `messages need 1 to ${CHAT_LIMITS.text} characters`) };
    const verdict = moderate(text);
    if (!verdict.allowed) return { failure: rejectContent(row, verdict, time) };
    return { text };
  }

  function findMessage(id) {
    const numeric = typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : NaN;
    const message = Number.isSafeInteger(numeric) ? store.message(numeric) : null;
    return message ? { message, numeric } : { failure: httpError(404, "CHAT_MESSAGE_NOT_FOUND", "that message is gone") };
  }

  function findTarget(id) {
    const numeric = typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : NaN;
    const row = Number.isSafeInteger(numeric) ? store.user(numeric) : null;
    return row ? { row } : { failure: httpError(404, "CHAT_USER_NOT_FOUND", "that user has not joined chat yet") };
  }

  function findTargetByName(name) {
    const row = typeof name === "string" && /^\w{1,32}$/.test(name) ? store.userByName(name) : null;
    return row ? { row } : { failure: httpError(404, "CHAT_USER_NOT_FOUND", "that user has not joined chat yet") };
  }

  function send(payload, row, ip, time) {
    if (!isChatChannel(payload.channel)) return httpError(400, "CHAT_CHANNEL_INVALID", "that channel does not exist");
    if (!canPostIn(row.role, payload.channel)) return httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can post here");
    const mine = activityOf(row.id, time);
    const source = sourceWindow(ip, time);
    if (mine.sends.length >= sendLimit || source.length >= sourceSendLimit) {
      return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    }
    const written = readText(payload, row, time);
    if (written.failure) return written.failure;
    const comparable = written.text.toLowerCase();
    if (mine.last?.text === comparable && time - mine.last.at < duplicateMs) {
      return httpError(429, "CHAT_DUPLICATE", "you just sent that");
    }
    let replyTo;
    if (payload.replyTo !== undefined) {
      const parent = findMessage(payload.replyTo);
      if (parent.failure || parent.message.channel !== payload.channel) {
        return httpError(404, "CHAT_MESSAGE_NOT_FOUND", "that message is gone");
      }
      replyTo = {
        id: parent.numeric,
        userId: Number(parent.message.author),
        name: parent.message.name,
        text: replySnippet(parent.message.text),
      };
    }
    mine.sends.push(time);
    source.push(time);
    sourceSends.set(ip, source);
    mine.last = { text: comparable, at: time };
    mine.typedAt = 0;
    const id = store.insertMessage({ channel: payload.channel, userId: row.id, text: written.text, time, reply: replyTo });
    const nonce = typeof payload.nonce === "string" && payload.nonce.length <= 40 ? payload.nonce : undefined;
    const message = { ...store.message(id), ...(nonce && { nonce }) };
    broadcast(frame("message", message));
    return ok({ message });
  }

  function edit(payload, row, time) {
    const { message, numeric, failure } = findMessage(payload.id);
    if (failure) return failure;
    if (message.author !== String(row.id)) return httpError(403, "CHAT_FORBIDDEN", "you can only edit your own messages");
    if (!canPostIn(row.role, message.channel)) return httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can post here");
    const mine = activityOf(row.id, time);
    if (mine.sends.length >= sendLimit) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    const written = readText(payload, row, time);
    if (written.failure) return written.failure;
    mine.sends.push(time);
    if (written.text === message.text) return ok({ message });
    store.editMessage(numeric, written.text, time);
    const updated = store.message(numeric);
    broadcast(frame("update", updated));
    return ok({ message: updated });
  }

  function remove(payload, row, time) {
    const { message, numeric, failure } = findMessage(payload.id);
    if (failure) return failure;
    const own = message.author === String(row.id);
    if (!own && !(canDeleteAny(row.role) && outranks(row.role, message.role))) {
      return httpError(403, "CHAT_FORBIDDEN", "you can not delete that message");
    }
    store.deleteMessage(numeric);
    if (!own) {
      store.audit({ time, actorId: row.id, action: "delete", targetId: Number(message.author), detail: message.text });
    }
    broadcast(frame("remove", { id: message.id, channel: message.channel }));
    return ok();
  }

  function react(payload, row, time) {
    if (!isChatReaction(payload.emoji)) return httpError(400, "CHAT_REACTION_INVALID", "that reaction is not available");
    const { numeric, failure } = findMessage(payload.id);
    if (failure) return failure;
    const mine = activityOf(row.id, time);
    if (mine.reacts.length >= reactLimit) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    mine.reacts.push(time);
    store.toggleReaction(numeric, row.id, payload.emoji, time);
    const updated = store.message(numeric);
    broadcast(frame("update", updated));
    return ok({ message: updated });
  }

  function typing(payload, row, time) {
    if (!isChatChannel(payload.channel)) return httpError(400, "CHAT_CHANNEL_INVALID", "that channel does not exist");
    if (!canPostIn(row.role, payload.channel)) return httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can post here");
    const mine = activityOf(row.id, time);
    if (time - mine.typedAt >= typingGapMs) {
      mine.typedAt = time;
      broadcast(frame("typing", { author: String(row.id), name: row.username, channel: payload.channel }));
    }
    return ok();
  }

  function minutesFrom(value, { optional = false } = {}) {
    if (optional && (value === undefined || value === null)) return null;
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_TIMEOUT_MINUTES ? minutes : undefined;
  }

  function moderateUser(actor, target, action, payload, time) {
    const actorRole = actor ? actor.role : "owner";
    const fromConsole = !actor;
    if (actor && actor.id === target.id) return httpError(403, "CHAT_FORBIDDEN", "you can not do that to yourself");
    const audit = (detail) =>
      store.audit({ time, actorId: actor?.id, action, targetId: target.id, detail: detail ?? null });

    if (action === "role") {
      const role = payload.role;
      if (!isChatRole(role)) return httpError(400, "CHAT_ROLE_INVALID", "that role does not exist");
      if (!fromConsole && !assignableRoles(actorRole, target.role).includes(role)) {
        return httpError(403, "CHAT_FORBIDDEN", "you can not give that role");
      }
      store.setRole(target.id, role);
      audit(`${target.role} -> ${role}`);
      for (const stream of streams.values()) if (stream.user.id === target.id) stream.user = { ...stream.user, role };
      broadcast(frame("role", { author: String(target.id), role }));
      sendTo(target.id, frame("viewer", viewer({ ...target, role })));
      announcePresence();
      return ok({ user: member({ ...target, role }) });
    }

    if (action === "timeout" || action === "untimeout") {
      if (!fromConsole && !canTimeout(actorRole, target.role)) return httpError(403, "CHAT_FORBIDDEN", "you can not time out that user");
      let until = 0;
      if (action === "timeout") {
        const minutes = minutesFrom(payload.minutes);
        if (!minutes) return httpError(400, "CHAT_DURATION_INVALID", "pick a timeout between 1 minute and 28 days");
        until = time + minutes * 60_000;
      }
      store.setMute(target.id, until);
      audit(until ? `${Math.round((until - time) / 60_000)} min` : null);
      sendTo(target.id, frame("muted", { until }));
      return ok({ user: { ...member(target), ...(until && { mutedUntil: until }) } });
    }

    if (action === "clearprofile") {
      if (!fromConsole && !canTimeout(actorRole, target.role)) return httpError(403, "CHAT_FORBIDDEN", "you can not reset that profile");
      const cleared = store.clearProfile(target.id);
      audit(null);
      announceProfile(cleared);
      return ok({ user: member(cleared) });
    }

    if (action === "ban" || action === "unban") {
      if (!fromConsole && !canBan(actorRole, target.role)) return httpError(403, "CHAT_FORBIDDEN", "you can not ban that user");
      if (action === "unban") {
        store.setBan(target.id, 0, null);
        audit(null);
        return ok({ user: member(target) });
      }
      const minutes = minutesFrom(payload.minutes, { optional: true });
      if (minutes === undefined) return httpError(400, "CHAT_DURATION_INVALID", "pick a ban length up to 28 days, or leave it empty");
      const until = minutes === null ? PERMANENT : time + minutes * 60_000;
      const reason = typeof payload.reason === "string" ? cleanChatText(payload.reason).slice(0, 200) || null : null;
      store.setBan(target.id, until, reason);
      const removed = payload.purge ? store.purge(target.id, time - PURGE_WINDOW_MS) : [];
      audit([minutes === null ? "permanent" : `${minutes} min`, reason, removed.length && `${removed.length} removed`].filter(Boolean).join(", "));
      for (const entry of removed) broadcast(frame("remove", entry));
      const banned = frame("banned", { ...(until < PERMANENT && { until }), ...(reason && { reason }) });
      for (const stream of [...streams.values()]) {
        if (stream.user.id !== target.id) continue;
        stream.send(banned);
        stream.close();
      }
      return ok({ user: member(target), removed: removed.length });
    }

    return httpError(400, "CHAT_REQUEST_INVALID", "this action is not valid");
  }

  function connect(row, signal) {
    const open = [...streams.values()].filter((stream) => stream.user.id === row.id).length;
    if (open >= maxStreamsPerUser) return reply(httpError(429, "RATE_LIMITED", "too many chat tabs are open"));
    const id = randomBytes(12).toString("base64url");
    let close = () => {};
    const body = new ReadableStream({
      start(controller) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        const stream = {
          user: streamUser(row),
          send(bytes) {
            if (controller.desiredSize > 0) controller.enqueue(bytes);
          },
          close: () => close(),
        };
        const abort = () => close();
        close = () => {
          if (streams.get(id) !== stream) return;
          streams.delete(id);
          signal?.removeEventListener("abort", abort);
          try {
            controller.close();
          } catch {}
          if (!streams.size) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          announcePresence();
        };
        streams.set(id, stream);
        signal?.addEventListener("abort", abort, { once: true });
        if (!heartbeat) {
          heartbeat = setInterval(() => broadcast(pingFrame), pingMs);
          heartbeat.unref?.();
        }
        stream.send(frame("viewer", viewer(row)));
        stream.send(frame("history", Object.fromEntries(CHAT_CHANNELS.map((channel) => [channel, store.recent(channel, historySize)]))));
        stream.send(frame("members", members()));
        announcePresence();
      },
      cancel() {
        close();
      },
    }, { highWaterMark: 64 });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  function profileOf(target, row) {
    const staff = canTimeout(row.role, "member");
    return {
      ...member(target),
      joinedAt: target.account_created_at ?? target.joined_at,
      ...(target.pronouns && { pronouns: target.pronouns }),
      ...(target.bio && { bio: target.bio }),
      ...(target.accent && { accent: target.accent }),
      ...(target.banner_hash && { banner: target.banner_hash }),
      ...(staff && target.muted_until > now() && { mutedUntil: target.muted_until }),
      ...(staff && target.banned_until > now() && { bannedUntil: target.banned_until }),
      ...(staff && target.ban_reason && target.banned_until > now() && { banReason: target.ban_reason }),
    };
  }

  function profile(url, row) {
    const { row: target, failure } = findTarget(url.searchParams.get("id"));
    if (failure) return failure;
    return ok({ profile: profileOf(target, row) });
  }

  function announceProfile(updated) {
    for (const stream of streams.values()) if (stream.user.id === updated.id) stream.user = streamUser(updated);
    broadcast(frame("profile", member(updated)));
  }

  function profileGate(request, row, time) {
    if (crossSite(request)) return httpError(403, "CHAT_REQUEST_DENIED", "this request is not allowed");
    if (row.muted_until > time) return httpError(403, "CHAT_MUTED", "you are timed out for a bit", { until: row.muted_until });
    const mine = activityOf(row.id, time);
    if (mine.profiles.length >= profileLimit) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    mine.profiles.push(time);
    return null;
  }

  async function editProfile(request, row) {
    const time = now();
    const length = request.headers.get("content-length");
    if (length && !(Number(length) <= BODY_MAX_BYTES)) return httpError(413, "CHAT_REQUEST_TOO_LARGE", "that profile is too large");
    const payload = await readJson(request);
    if (!payload) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    const fields = {};
    for (const field of CHAT_PROFILE_TEXT) {
      if (payload[field] === undefined) continue;
      const text = payload[field] === null ? "" : cleanProfileText(field, payload[field]);
      if (text === null) return httpError(400, "CHAT_PROFILE_INVALID", `that ${PROFILE_LABELS[field]} is too long`, { field });
      fields[field] = text;
    }
    if (payload.accent !== undefined) {
      if (payload.accent !== null && !isChatAccent(payload.accent)) {
        return httpError(400, "CHAT_PROFILE_INVALID", "that color is not valid", { field: "accent" });
      }
      fields.accent = payload.accent;
    }
    for (const kind of Object.keys(CHAT_MEDIA)) {
      if (payload[kind] === undefined) continue;
      if (payload[kind] !== null) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
      fields[kind] = null;
    }
    if (!Object.keys(fields).length) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    const gate = profileGate(request, row, time);
    if (gate) return gate;
    for (const field of CHAT_PROFILE_TEXT) {
      if (!fields[field]) continue;
      const verdict = moderate(fields[field]);
      if (verdict.allowed) continue;
      const until = strike(row, verdict.strikes, time);
      return httpError(422, "CHAT_PROFILE_BLOCKED", blockedNotice(PROFILE_LABELS[field], verdict.category), {
        field,
        category: verdict.category,
        ...(until && { until }),
      });
    }
    const updated = store.updateProfile(row.id, fields, time);
    announceProfile(updated);
    return ok({ profile: profileOf(updated, updated) });
  }

  async function upload(request, kind, row) {
    const time = now();
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!CHAT_MEDIA_TYPES.includes(type)) return httpError(415, "CHAT_MEDIA_INVALID", "that image type is not supported");
    const limits = type === "image/gif" ? CHAT_MEDIA[kind].gif : CHAT_MEDIA[kind];
    const length = request.headers.get("content-length");
    if (length && !(Number(length) <= limits.bytes)) return httpError(413, "CHAT_MEDIA_TOO_LARGE", "that image is too large");
    if (uploading.has(row.id)) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    const gate = profileGate(request, row, time);
    if (gate) return gate;
    uploading.add(row.id);
    try {
      const bytes = await readBody(request, limits.bytes);
      if (!bytes) return httpError(413, "CHAT_MEDIA_TOO_LARGE", "that image is too large");
      const image = readChatImage(bytes, type, limits);
      if (!image) return httpError(400, "CHAT_MEDIA_INVALID", "that image could not be used");
      const verdict = await checkImage(image.bytes, type);
      if (verdict.invalid) return httpError(400, "CHAT_MEDIA_INVALID", "that image could not be used");
      if (verdict.varied) return httpError(400, "CHAT_MEDIA_TOO_VARIED", "that gif has too many different frames, try a shorter one");
      if (verdict.unavailable) return httpError(503, "CHAT_MEDIA_CHECK_UNAVAILABLE", "image checks are unavailable right now");
      if (!verdict.allowed) {
        const until = strike(row, 1, time);
        return httpError(422, "CHAT_MEDIA_BLOCKED", blockedNotice(kind, verdict.category), {
          kind,
          category: verdict.category,
          ...(until && { until }),
        });
      }
      const updated = store.putMedia(row.id, kind, image, time);
      announceProfile(updated);
      return ok({ profile: profileOf(updated, updated) });
    } finally {
      uploading.delete(row.id);
    }
  }

  function media(request, kind, id) {
    const stored = store.media(Number(id), kind);
    if (!stored) return reply(httpError(404, "CHAT_MEDIA_NOT_FOUND", "that image is gone"));
    const etag = `"${stored.hash}"`;
    const immutable = new URL(request.url).searchParams.get("v") === stored.hash;
    const headers = {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ETag: etag,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(stored.bytes, { headers: { ...headers, "Content-Type": stored.type } });
  }

  function history(url) {
    const channel = url.searchParams.get("channel");
    if (!isChatChannel(channel)) return httpError(400, "CHAT_CHANNEL_INVALID", "that channel does not exist");
    const before = Number(url.searchParams.get("before"));
    if (!Number.isSafeInteger(before) || before < 1) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    return ok({ messages: store.recent(channel, historySize, before) });
  }

  async function action(request, row, ip) {
    if (crossSite(request)) return httpError(403, "CHAT_REQUEST_DENIED", "this request is not allowed");
    const length = request.headers.get("content-length");
    if (length && !(Number(length) <= BODY_MAX_BYTES)) return httpError(413, "CHAT_REQUEST_TOO_LARGE", "message is too large");
    const payload = await readJson(request);
    if (!payload) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    const time = now();
    const type = payload.type ?? "send";
    if (type === "delete") return remove(payload, row, time);
    if (["role", "timeout", "untimeout", "ban", "unban", "clearprofile"].includes(type)) {
      const { row: target, failure } =
        payload.targetName === undefined ? findTarget(payload.target) : findTargetByName(payload.targetName);
      if (failure) return failure;
      return moderateUser(row, target, type, payload, time);
    }
    if (row.muted_until > time) return httpError(403, "CHAT_MUTED", "you are timed out for a bit", { until: row.muted_until });
    if (type === "send") return send(payload, row, ip, time);
    if (type === "edit") return edit(payload, row, time);
    if (type === "react") return react(payload, row, time);
    if (type === "typing") return typing(payload, row, time);
    return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
  }

  async function handle(request, { ip = "unknown" } = {}) {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/chat\//, "");
    const method = request.method;
    const mediaRoute = MEDIA_ROUTE.exec(route);
    if (mediaRoute?.[2] && (method === "GET" || method === "HEAD")) return media(request, mediaRoute[1], mediaRoute[2]);
    const known =
      (["message", "profile"].includes(route) && method === "POST") ||
      (mediaRoute && !mediaRoute[2] && method === "POST") ||
      (["stream", "me", "history", "profile"].includes(route) && method === "GET");
    if (!known) return reply(httpError(404, "CHAT_ROUTE_NOT_FOUND", "not found"));
    const { row, failure } = await session(request, ip);
    if (failure) return reply(failure);
    if (route === "stream") return connect(row, request.signal);
    if (route === "me") return json(200, { viewer: viewer(row) });
    let result;
    if (route === "history") result = history(url);
    else if (route === "profile") result = method === "POST" ? await editProfile(request, row) : profile(url, row);
    else if (mediaRoute) result = await upload(request, mediaRoute[1], row);
    else result = await action(request, row, ip);
    return json(result.status, result.body);
  }

  function describe(row) {
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      joinedAt: row.joined_at,
      lastSeen: row.last_seen,
      ...(row.muted_until > now() && { mutedUntil: row.muted_until }),
      ...(row.banned_until > now() && { bannedUntil: row.banned_until, ...(row.ban_reason && { banReason: row.ban_reason }) }),
    };
  }

  function control(command) {
    const time = now();
    const action = command?.action;
    if (action === "staff") return { ok: true, users: store.staff().map(describe) };
    if (action === "audit") {
      const limit = Math.min(200, Math.max(1, Number(command.limit) || 20));
      return { ok: true, entries: store.auditLog(limit) };
    }
    if (typeof command?.username !== "string" || !command.username) return { error: "a username is needed" };
    const target = store.userByName(command.username);
    if (!target) return { error: "that user has not joined chat yet" };
    if (action === "user") return { ok: true, user: describe(target) };
    const result = moderateUser(null, target, action, command, time);
    if (result.status !== 200) return { error: result.body.error };
    return { ok: true, user: describe(store.user(target.id)), ...(result.body.removed !== undefined && { removed: result.body.removed }) };
  }

  function close() {
    clearInterval(heartbeat);
    clearTimeout(presenceTimer);
    heartbeat = undefined;
    presenceTimer = undefined;
    for (const stream of [...streams.values()]) stream.close();
  }

  return { handle, control, close, count: () => streams.size };
}
