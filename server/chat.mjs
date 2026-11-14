import { createHash, randomBytes } from "crypto";
import { httpError } from "./errors.mjs";
import { ChatAuthUnavailable } from "./chat-auth.mjs";
import { PERMANENT } from "./chat-store.mjs";
import { chatAudioVideoDemuxer } from "./chat-audio-video.mjs";
import { chatImageType, readChatImage } from "./chat-media.mjs";
import { createChatGifs } from "./chat-gifs.mjs";
import { createPartyRegistry } from "./chat-party.mjs";
import { textVerdict } from "./chat-text-policy.mjs";
import { moderate, readModeration } from "../src/features/chat/moderation.ts";
import { blockedNotice } from "../src/features/chat/moderationNotice.ts";
import {
  CHAT_CHANNELS,
  CHAT_LIMITS,
  CHAT_MEDIA,
  CHAT_MEDIA_TYPES,
  CHAT_ATTACHMENT,
  CHAT_CONVERSATION_LIMITS,
  CHAT_PARTY_LIMITS,
  CHAT_PROFILE_TEXT,
  CHAT_UPLOAD_BYTES,
  attachmentKind,
  canPostIn,
  canReadChannel,
  cleanChatText,
  cleanConversationName,
  cleanProfileText,
  conversationIdOf,
  conversationKey,
  isChatAccent,
  isChatChannel,
  isChatReaction,
  isChatTarget,
  isConversationKey,
  isPartyControl,
  isPartyId,
  readPartyMedia,
  replySnippet,
  sortMembers,
} from "../src/features/chat/chatProtocol.ts";
import {
  assignableRoles,
  canBan,
  canDeleteAny,
  canTimeout,
  isChatRole,
  outranks,
} from "../src/features/chat/chatRoles.ts";

const BODY_MAX_BYTES = 4096;
const PURGE_WINDOW_MS = 24 * 60 * 60_000;
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const NAME_CACHE_LIMIT = 2_000;
const MEDIA_ROUTE = /^media\/(avatar|banner)(?:\/(\d{1,15}))?$/;
const ATTACHMENT_ROUTE = /^media\/message\/(\d{1,15})$/;
const GIF_ROUTE = /^gifs\/([A-Za-z0-9_-]{1,128})$/;
const PROFILE_LABELS = { display: "display name", pronouns: "pronouns", status: "status", bio: "bio" };
const MEMBER_CACHE_LIMIT = 10_000;
const PARTY_POSITION_MAX = 86_400;
const USER_QUERY_MAX = 32;

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

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : false;
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
  prepareMedia = async () => ({ unavailable: true }),
  checkText = async () => null,
  warmText = () => {},
  gifs = createChatGifs(),
  historySize = CHAT_LIMITS.page,
  maxStreamsPerUser = 8,
  pingMs = 20_000,
  presenceDelayMs = 250,
  sendLimit = 5,
  sendWindowMs = 8_000,
  sourceSendLimit = 30,
  reactLimit = 12,
  typingGapMs = 1_500,
  draftLimit = 20,
  strikeLimit = 3,
  strikeDecayMs = 5 * 60_000,
  muteMs = 2 * 60_000,
  maxMuteMs = 60 * 60_000,
  profileLimit = 8,
  profileWindowMs = 60_000,
  socialLimit = 20,
  searchLimit = 20,
  partyWatchers = CHAT_PARTY_LIMITS.watchers,
  partyIdleMs = CHAT_PARTY_LIMITS.idleMs,
  partyMaxMs = CHAT_PARTY_LIMITS.maxMs,
  partyStateLimit = 8,
  partyStateWindowMs = 4_000,
  maxPartyStreamsPerUser = 4,
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
  let announced = new Map();

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
  const memberCache = new Map();
  const parties = createPartyRegistry({
    now,
    frame,
    pingFrame,
    pingMs,
    member,
    delayMs: presenceDelayMs,
    idleMs: partyIdleMs,
    maxMs: partyMaxMs,
    messageLimit: CHAT_PARTY_LIMITS.messages,
    announce: (party) => broadcast(frame("party", party), party.target),
  });

  function broadcast(bytes, channel) {
    const allowed = isConversationKey(channel) ? membersOf(conversationIdOf(channel)) : null;
    for (const stream of streams.values()) {
      if (!channel || (allowed ? allowed.has(stream.user.id) : canReadChannel(stream.user.role, channel))) stream.send(bytes);
    }
  }

  function membersOf(id) {
    let ids = memberCache.get(id);
    if (!ids) {
      if (memberCache.size >= MEMBER_CACHE_LIMIT) memberCache.clear();
      ids = new Set(store.memberIds(id));
      memberCache.set(id, ids);
    }
    return ids;
  }

  function canRead(target, row) {
    if (isConversationKey(target)) return membersOf(conversationIdOf(target)).has(row.id);
    return isChatChannel(target) && canReadChannel(row.role, target);
  }

  const invalid = () => httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
  const rateLimited = () => httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
  const conversationMissing = () => httpError(404, "CHAT_CONVERSATION_NOT_FOUND", "that conversation does not exist");
  const partyMissing = () => httpError(404, "CHAT_PARTY_NOT_FOUND", "that watch party has ended");
  const groupFull = () => httpError(409, "CHAT_GROUP_FULL", "that group is full");
  const nameOf = (row) => row.display || row.username;

  function targetGate(target, row) {
    if (!isChatTarget(target)) return httpError(400, "CHAT_CHANNEL_INVALID", "that channel does not exist");
    if (isConversationKey(target)) return canRead(target, row) ? null : conversationMissing();
    return canPostIn(row.role, target) ? null : httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can post here");
  }

  function hasStream(userId) {
    for (const stream of streams.values()) if (stream.user.id === userId) return true;
    return false;
  }

  function preview(row) {
    const text = row.text ? replySnippet(row.text) : row.party ? "[watch party]" : row.attachment_type ? `[${attachmentKind(row.attachment_type)}]` : "";
    return { author: String(row.user_id), name: row.display || row.username, text };
  }

  function conversationView(stored) {
    return {
      key: conversationKey(stored.id),
      kind: stored.kind,
      ...(stored.name && { name: stored.name }),
      ...(stored.kind === "group" && stored.owner && { owner: String(stored.owner) }),
      members: stored.members.map(member),
      createdAt: stored.createdAt,
      lastAt: stored.lastAt,
      ...(stored.last && { last: preview(stored.last) }),
      unread: stored.unread,
      ...(stored.mentioned && { mentioned: true }),
    };
  }

  const viewFor = (id, userId) => conversationView(store.conversation(id, userId));

  function sendConversation(id, userIds = [...membersOf(id)]) {
    for (const userId of userIds) {
      if (!hasStream(userId)) continue;
      const stored = store.conversation(id, userId);
      if (stored && !stored.hidden) sendTo(userId, frame("conversation", conversationView(stored)));
    }
  }

  function dropConversationFor(userId, id) {
    sendTo(userId, frame("conversation-remove", { key: conversationKey(id) }));
  }

  function insertInto(entry) {
    const conversation = isConversationKey(entry.channel) ? conversationIdOf(entry.channel) : 0;
    const hidden = conversation && !entry.notice ? store.hiddenMembers(conversation) : [];
    const message = store.message(store.insertMessage(entry));
    if (hidden.length) sendConversation(conversation, hidden);
    return message;
  }

  function postNotice(id, userId, notice, time) {
    const message = insertInto({ channel: conversationKey(id), userId, text: "", time, notice });
    broadcast(frame("message", message), message.channel);
  }

  function endPartiesIn(target) {
    for (const party of parties.list()) if (party.target === target) parties.end(party);
  }

  function revokeParties(userId) {
    const row = store.user(userId);
    const lost = (party) => !row || !canRead(party.target, row);
    parties.closeStreams(userId, lost);
    for (const party of parties.list()) if (party.host === userId && lost(party)) parties.end(party);
  }

  function dropParties(userId) {
    parties.closeStreams(userId, () => true);
    for (const party of parties.list()) if (party.host === userId) parties.end(party);
  }

  function forgetUser(userId, memberships) {
    memberCache.clear();
    for (const stream of [...streams.values()]) if (stream.user.id === userId) stream.close();
    dropParties(userId);
    for (const { id, kind, members: ids } of memberships) {
      const exists = !!store.conversationInfo(id);
      if (!exists) endPartiesIn(conversationKey(id));
      if (kind === "dm") for (const other of ids) if (other !== userId) dropConversationFor(other, id);
      if (kind === "group" && exists) sendConversation(id);
    }
  }

  function visibleHistory(role) {
    return Object.fromEntries(CHAT_CHANNELS.filter((channel) => canReadChannel(role, channel))
      .map((channel) => [channel, store.recent(channel, historySize)]));
  }

  function sendTo(userId, bytes) {
    for (const stream of streams.values()) if (stream.user.id === userId) stream.send(bytes);
  }

  function members() {
    const byUser = new Map();
    for (const stream of streams.values()) byUser.set(stream.user.id, stream.user);
    return sortMembers([...byUser.values()].map(member));
  }

  function announcePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      const current = new Map(members().map((entry) => [entry.author, JSON.stringify(entry)]));
      const join = [];
      for (const [author, shown] of current) if (announced.get(author) !== shown) join.push(JSON.parse(shown));
      const leave = [...announced.keys()].filter((author) => !current.has(author));
      announced = current;
      if (join.length || leave.length) broadcast(frame("presence", { join, leave }));
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

  async function session(request, ip, browser) {
    let identity;
    try {
      identity = await identify(request, ip);
    } catch (error) {
      if (!(error instanceof ChatAuthUnavailable)) throw error;
      return { failure: httpError(503, "CHAT_AUTH_UNAVAILABLE", "chat login check is unavailable right now") };
    }
    if (!identity) return { failure: httpError(401, "CHAT_LOGIN_REQUIRED", "log in to use chat") };
    const previous = store.user(identity.id);
    const recycled = previous && previous.username !== identity.username ? store.memberships(identity.id) : null;
    let row = store.identify(identity, now());
    if (recycled) forgetUser(row.id, recycled);
    store.guard.observe(row, browser, now());
    if (row.banned_until > now()) store.guard.restrict(row, "ban", row.banned_until);
    if (row.muted_until > now()) store.guard.restrict(row, "timeout", row.muted_until);
    row = store.guard.apply(row, now());
    if (row.banned_until > now()) {
      refreshRestrictions();
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
      entry = {
        sends: [], reacts: [], profiles: [], drafts: [], socials: [], searches: [], states: [],
        typedAt: 0, draft: undefined,
      };
      activity.set(userId, entry);
    }
    entry.sends = entry.sends.filter((at) => time - at < sendWindowMs);
    entry.reacts = entry.reacts.filter((at) => time - at < sendWindowMs);
    entry.drafts = entry.drafts.filter((at) => time - at < sendWindowMs);
    entry.profiles = entry.profiles.filter((at) => time - at < profileWindowMs);
    entry.socials = entry.socials.filter((at) => time - at < profileWindowMs);
    entry.searches = entry.searches.filter((at) => time - at < sendWindowMs);
    entry.states = entry.states.filter((at) => time - at < partyStateWindowMs);
    return entry;
  }

  function sourceWindow(ip, time) {
    const list = (sourceSends.get(ip) || []).filter((at) => time - at < sendWindowMs);
    if (list.length) sourceSends.set(ip, list);
    else sourceSends.delete(ip);
    if (sourceSends.size > 10_000) sourceSends.clear();
    return list;
  }

  function announce(channel, target, notice, time) {
    if (!isChatChannel(channel)) return;
    const message = store.message(store.insertMessage({ channel, userId: target.id, text: "", time, notice }));
    broadcast(frame("message", message), channel);
  }

  function strike(stale, points, time, channel) {
    if (!points) return 0;
    const row = store.user(stale.id) ?? stale;
    const steps = Math.floor((time - row.strike_updated) / strikeDecayMs);
    let current = Math.max(0, row.strike_points - Math.max(0, steps)) + points;
    let mutes = row.mute_count;
    let mutedUntil = row.muted_until;
    if (current >= strikeLimit) {
      mutedUntil = time + Math.min(maxMuteMs, muteMs * 2 ** mutes);
      mutes += 1;
      current = 0;
    }
    store.setStrikes(row.id, { points: current, updated: time, mutes, mutedUntil });
    if (mutes > row.mute_count) {
      store.guard.restrict(row, "timeout", mutedUntil);
      refreshRestrictions();
    }
    if (mutes > row.mute_count) announce(channel, row, { action: "timeout", until: mutedUntil }, time);
    return mutedUntil > time ? mutedUntil : 0;
  }

  function rejectContent(row, verdict, time, channel) {
    const until = strike(row, verdict.strikes, time, channel);
    return httpError(422, "CHAT_MESSAGE_BLOCKED", blockedNotice("message", verdict.category), {
      category: verdict.category,
      ...(until && { until }),
    });
  }

  async function screenText(text, mine, options) {
    const key = mine && createHash("sha256").update(text).digest("base64");
    if (key && mine.draft?.key === key) return mine.draft.verdict;
    const reading = readModeration(text);
    if (!reading.verdict.allowed || (!reading.screen && !reading.suspect)) return reading.verdict;
    const scores = await checkText(text, options);
    const verdict = textVerdict(reading, scores);
    if (key && scores) mine.draft = { key, verdict };
    return verdict;
  }

  function silenced(row) {
    const fresh = store.guard.apply(store.user(row.id) ?? row, now());
    const time = now();
    if (fresh.banned_until > time) {
      return httpError(403, "CHAT_BANNED", "you are banned from chat", {
        ...(fresh.banned_until < PERMANENT && { until: fresh.banned_until }),
        ...(fresh.ban_reason && { reason: fresh.ban_reason }),
      });
    }
    if (fresh.muted_until > time) return httpError(403, "CHAT_MUTED", "you are timed out for a bit", { until: fresh.muted_until });
    return null;
  }

  function refreshRestrictions() {
    const ids = new Set([...streams.values()].map((stream) => stream.user.id));
    for (const party of parties.list()) {
      ids.add(party.host);
      for (const stream of party.streams.values()) ids.add(stream.user.id);
    }
    for (const id of ids) {
      const row = store.user(id);
      if (!row) continue;
      const fresh = store.guard.apply(row, now());
      if (fresh.banned_until > now()) {
        const banned = frame("banned", {
          ...(fresh.banned_until < PERMANENT && { until: fresh.banned_until }),
          ...(fresh.ban_reason && { reason: fresh.ban_reason }),
        });
        for (const stream of [...streams.values()]) {
          if (stream.user.id !== id) continue;
          stream.send(banned);
          stream.close();
        }
        dropParties(id);
      } else {
        sendTo(id, frame("muted", { until: fresh.muted_until > now() ? fresh.muted_until : 0 }));
      }
    }
  }

  function readText(payload, hasAttachment = false) {
    const text = cleanChatText(payload.text);
    return text || (hasAttachment && (payload.text === undefined || payload.text === ""))
      ? { text }
      : { failure: httpError(400, "CHAT_TEXT_INVALID", `messages need 1 to ${CHAT_LIMITS.text} characters`) };
  }

  async function screenMessage(text, row, time, channel) {
    const verdict = await screenText(text, activityOf(row.id, time));
    if (!verdict.allowed) return rejectContent(row, verdict, time, channel);
    return silenced(row);
  }

  function findMessage(id, row) {
    const numeric = typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : NaN;
    const message = Number.isSafeInteger(numeric) ? store.message(numeric) : null;
    return message && canRead(message.channel, store.user(row.id) ?? row)
      ? { message, numeric }
      : { failure: httpError(404, "CHAT_MESSAGE_NOT_FOUND", "that message is gone") };
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

  async function send(payload, row, ip, time, file) {
    const gate = targetGate(payload.channel, row);
    if (gate) return gate;
    const mine = activityOf(row.id, time);
    const source = sourceWindow(ip, time);
    if (mine.sends.length >= sendLimit || source.length >= sourceSendLimit) {
      return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    }
    const written = readText(payload, !!file);
    if (written.failure) return written.failure;
    let attachment;
    let frames = [];
    if (file) {
      if (file.size > CHAT_UPLOAD_BYTES) return httpError(413, "CHAT_MEDIA_TOO_LARGE", "that file is too large", { kind: "file" });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = chatImageType(bytes);
      if (type) {
        const limits = type === "image/gif" ? CHAT_ATTACHMENT.gif : CHAT_ATTACHMENT;
        if (file.size > limits.bytes) return httpError(413, "CHAT_MEDIA_TOO_LARGE", "that image is too large");
        attachment = readChatImage(bytes, type, limits);
        if (!attachment) return httpError(400, "CHAT_MEDIA_INVALID", "that image could not be used");
        frames = [attachment];
      } else {
        if (!chatAudioVideoDemuxer(bytes)) return httpError(415, "CHAT_MEDIA_INVALID", "that file type is not supported", { kind: "file" });
        const prepared = await prepareMedia(bytes);
        if (!prepared.media) return mediaFailure(prepared);
        attachment = prepared.media;
        frames = prepared.frames;
      }
    }
    let replyTo;
    if (payload.replyTo !== undefined) {
      const parent = findMessage(payload.replyTo, row);
      if (parent.failure || parent.message.notice || parent.message.channel !== payload.channel) {
        return httpError(404, "CHAT_MESSAGE_NOT_FOUND", "that message is gone");
      }
      replyTo = {
        id: parent.numeric,
        userId: Number(parent.message.author),
        name: parent.message.name,
        text: replySnippet(parent.message.text || (parent.message.attachment ? `[${attachmentKind(parent.message.attachment.type)}]` : parent.message.party ? "[watch party]" : "")),
      };
    }
    mine.sends.push(time);
    source.push(time);
    sourceSends.set(ip, source);
    const refused = await screenMessage(written.text, row, time, payload.channel);
    if (refused) return refused;
    if (frames.length) {
      const rejected = await screenFrames(frames, attachmentKind(attachment.type), row, time, payload.channel);
      if (rejected) return rejected;
    }
    const fresh = store.user(row.id);
    const silencedAfterCheck = silenced(row);
    if (silencedAfterCheck) return silencedAfterCheck;
    const lost = fresh ? targetGate(payload.channel, fresh) : httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can post here");
    if (lost) return lost;
    mine.typedAt = 0;
    const stored = insertInto({ channel: payload.channel, userId: row.id, text: written.text, time, reply: replyTo, attachment });
    const nonce = typeof payload.nonce === "string" && payload.nonce.length <= 40 ? payload.nonce : undefined;
    const message = { ...stored, ...(nonce && { nonce }) };
    broadcast(frame("message", message), message.channel);
    return ok({ message });
  }

  async function edit(payload, row, time) {
    const { message, numeric, failure } = findMessage(payload.id, row);
    if (failure) return failure;
    if (message.notice || message.party || message.author !== String(row.id)) {
      return httpError(403, "CHAT_FORBIDDEN", "you can only edit your own messages");
    }
    const gate = targetGate(message.channel, row);
    if (gate) return gate;
    const mine = activityOf(row.id, time);
    if (mine.sends.length >= sendLimit) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    const written = readText(payload, !!message.attachment);
    if (written.failure) return written.failure;
    mine.sends.push(time);
    if (written.text === message.text) return ok({ message });
    const refused = await screenMessage(written.text, row, time, message.channel);
    if (refused) return refused;
    const lost = targetGate(message.channel, store.user(row.id) ?? row);
    if (lost) return lost;
    if (!store.message(numeric)) return httpError(404, "CHAT_MESSAGE_NOT_FOUND", "that message is gone");
    store.editMessage(numeric, written.text, time);
    const updated = store.message(numeric);
    broadcast(frame("update", updated), updated.channel);
    return ok({ message: updated });
  }

  function remove(payload, row, time) {
    const { message, numeric, failure } = findMessage(payload.id, row);
    if (failure) return failure;
    const own = !message.notice && message.author === String(row.id);
    if (!own && !(isChatChannel(message.channel) && canDeleteAny(row.role) && outranks(row.role, message.role))) {
      return httpError(403, "CHAT_FORBIDDEN", "you can not delete that message");
    }
    store.deleteMessage(numeric);
    if (!own) {
      store.audit({ time, actorId: row.id, action: "delete", targetId: Number(message.author), detail: message.text });
    }
    broadcast(frame("remove", { id: message.id, channel: message.channel }), message.channel);
    return ok();
  }

  function react(payload, row, time) {
    if (!isChatReaction(payload.emoji)) return httpError(400, "CHAT_REACTION_INVALID", "that reaction is not available");
    const { message, numeric, failure } = findMessage(payload.id, row);
    if (failure) return failure;
    if (message.notice) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    const mine = activityOf(row.id, time);
    if (mine.reacts.length >= reactLimit) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    mine.reacts.push(time);
    store.toggleReaction(numeric, row.id, payload.emoji, time);
    const updated = store.message(numeric);
    broadcast(frame("update", updated), updated.channel);
    return ok({ message: updated });
  }

  function typing(payload, row, time) {
    const gate = targetGate(payload.channel, row);
    if (gate) return gate;
    warmText();
    const mine = activityOf(row.id, time);
    if (time - mine.typedAt >= typingGapMs) {
      mine.typedAt = time;
      broadcast(frame("typing", { author: String(row.id), name: row.username, channel: payload.channel }), payload.channel);
    }
    return ok();
  }

  async function draft(payload, row, time) {
    const text = cleanChatText(payload.text);
    const mine = activityOf(row.id, time);
    if (!text) return ok();
    if (mine.drafts.length >= draftLimit) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
    mine.drafts.push(time);
    const verdict = await screenText(text, mine, { draft: true, userId: row.id });
    return ok({ ok: true, ...(!verdict.allowed && { category: verdict.category }) });
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
    const channel = isChatChannel(payload.channel) && canReadChannel(actorRole, payload.channel) ? payload.channel : undefined;

    if (action === "role") {
      const role = payload.role;
      if (!isChatRole(role)) return httpError(400, "CHAT_ROLE_INVALID", "that role does not exist");
      if (!fromConsole && !assignableRoles(actorRole, target.role).includes(role)) {
        return httpError(403, "CHAT_FORBIDDEN", "you can not give that role");
      }
      store.setRole(target.id, role);
      audit(`${target.role} -> ${role}`);
      for (const stream of streams.values()) if (stream.user.id === target.id) stream.user = { ...stream.user, role };
      parties.refresh(target.id, { role });
      revokeParties(target.id);
      broadcast(frame("role", { author: String(target.id), role }));
      sendTo(target.id, frame("viewer", viewer({ ...target, role })));
      if (canReadChannel(target.role, "staff-chat") !== canReadChannel(role, "staff-chat")) {
        sendTo(target.id, frame("history", visibleHistory(role)));
      }
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
      store.guard.restrict(target, "timeout", until);
      audit(until ? `${Math.round((until - time) / 60_000)} min` : null);
      refreshRestrictions();
      if (until) announce(channel, target, { action, until }, time);
      else if (target.muted_until > time) announce(channel, target, { action }, time);
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
        store.guard.restrict(target, "ban", 0);
        audit(null);
        if (target.banned_until > time) announce(channel, target, { action }, time);
        return ok({ user: member(target) });
      }
      const minutes = minutesFrom(payload.minutes, { optional: true });
      if (minutes === undefined) return httpError(400, "CHAT_DURATION_INVALID", "pick a ban length up to 28 days, or leave it empty");
      const until = minutes === null ? PERMANENT : time + minutes * 60_000;
      const reason = typeof payload.reason === "string" ? cleanChatText(payload.reason).slice(0, 200) || null : null;
      store.setBan(target.id, until, reason);
      store.guard.restrict(target, "ban", until);
      const removed = payload.purge ? store.purge(target.id, time - PURGE_WINDOW_MS) : [];
      audit([minutes === null ? "permanent" : `${minutes} min`, reason, removed.length && `${removed.length} removed`].filter(Boolean).join(", "));
      for (const entry of removed) broadcast(frame("remove", entry), entry.channel);
      refreshRestrictions();
      dropParties(target.id);
      announce(channel, target, { action, ...(until < PERMANENT && { until }) }, time);
      return ok({ user: member(target), removed: removed.length });
    }

    return httpError(400, "CHAT_REQUEST_INVALID", "this action is not valid");
  }

  function connect(row, signal) {
    const open = [...streams.values()].filter((stream) => stream.user.id === row.id).length;
    if (open >= maxStreamsPerUser) return reply(httpError(429, "RATE_LIMITED", "too many chat tabs are open"));
    warmText();
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
            else close();
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
        stream.send(frame("history", visibleHistory(row.role)));
        stream.send(frame("members", members()));
        stream.send(frame("conversations", store.conversations(row.id).map(conversationView)));
        stream.send(frame("parties", parties.list().filter((party) => canRead(party.target, row)).map(parties.view)));
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
    parties.refresh(updated.id, streamUser(updated));
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
      const verdict = await screenText(fields[field]);
      if (verdict.allowed) continue;
      const until = strike(row, verdict.strikes, time);
      return httpError(422, "CHAT_PROFILE_BLOCKED", blockedNotice(PROFILE_LABELS[field], verdict.category), {
        field,
        category: verdict.category,
        ...(until && { until }),
      });
    }
    const refused = silenced(row);
    if (refused) return refused;
    const updated = store.updateProfile(row.id, fields, time);
    announceProfile(updated);
    return ok({ profile: profileOf(updated, updated) });
  }

  function mediaFailure(prepared) {
    const kind = prepared.kind ?? "file";
    if (prepared.tooLarge) return httpError(413, "CHAT_MEDIA_TOO_LARGE", `that ${kind} is too large`, { kind });
    if (prepared.tooLong) return httpError(400, "CHAT_MEDIA_TOO_LONG", `that ${kind} is too long`, { kind });
    if (prepared.unsupported) return httpError(415, "CHAT_MEDIA_INVALID", `that ${kind} format is not supported`, { kind });
    if (prepared.invalid) return httpError(400, "CHAT_MEDIA_INVALID", `that ${kind} could not be used`, { kind });
    return httpError(503, "CHAT_MEDIA_CHECK_UNAVAILABLE", "media checks are unavailable right now", { kind });
  }

  async function screenImage(image, kind, row, time, channel) {
    return screenFrames([image], kind, row, time, channel);
  }

  async function screenFrames(frames, kind, row, time, channel) {
    const video = kind === "video" ? { kind } : {};
    for (const frame of frames) {
      const verdict = await checkImage(frame.bytes, frame.type);
      if (verdict?.invalid) return httpError(400, "CHAT_MEDIA_INVALID", `that ${video.kind ?? "image"} could not be used`, video);
      if (verdict?.varied) return httpError(400, "CHAT_MEDIA_TOO_VARIED", "that gif has too many different frames, try a shorter one");
      if (!verdict || verdict.unavailable || (verdict.allowed !== true && !verdict.category)) {
        return httpError(503, "CHAT_MEDIA_CHECK_UNAVAILABLE", `${video.kind ?? "image"} checks are unavailable right now`, video);
      }
      if (!verdict.allowed) {
        const until = strike(row, 1, time, channel);
        return httpError(422, "CHAT_MEDIA_BLOCKED", blockedNotice(kind, verdict.category), {
          kind, category: verdict.category, ...(until && { until }),
        });
      }
    }
    return silenced(row);
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
      const refused = await screenImage(image, kind, row, time);
      if (refused) return refused;
      const updated = store.putMedia(row.id, kind, image, time);
      announceProfile(updated);
      return ok({ profile: profileOf(updated, updated) });
    } finally {
      uploading.delete(row.id);
    }
  }

  function media(request, kind, id) {
    const stored = kind === "message" ? store.attachment(Number(id)) : store.media(Number(id), kind);
    if (!stored) return reply(httpError(404, "CHAT_MEDIA_NOT_FOUND", "that image is gone"));
    const etag = `"${stored.hash}"`;
    const immutable = new URL(request.url).searchParams.get("v") === stored.hash;
    const headers = {
      "Cache-Control": kind === "message" ? "private, no-cache" : immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ETag: etag,
      "Accept-Ranges": "bytes",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const size = stored.bytes.length;
    const range = byteRange(request.headers.get("range"), size);
    if (range === false) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    const body = request.method === "HEAD" ? null : range ? stored.bytes.subarray(range.start, range.end + 1) : stored.bytes;
    if (!range) return new Response(body, { headers: { ...headers, "Content-Type": stored.type } });
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Type": stored.type, "Content-Range": `bytes ${range.start}-${range.end}/${size}` },
    });
  }

  function history(url, row) {
    const channel = url.searchParams.get("channel");
    if (!isChatTarget(channel)) return httpError(400, "CHAT_CHANNEL_INVALID", "that channel does not exist");
    if (isConversationKey(channel)) {
      if (!canRead(channel, row)) return conversationMissing();
    } else if (!canReadChannel(row.role, channel)) {
      return httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can access this channel");
    }
    const raw = url.searchParams.get("before");
    const before = raw === null || raw === "" ? Number.MAX_SAFE_INTEGER : Number(raw);
    if (!Number.isSafeInteger(before) || before < 1) return invalid();
    return ok({ messages: store.recent(channel, historySize, before) });
  }

  function users(url, row) {
    const time = now();
    const query = (url.searchParams.get("q") ?? "").trim();
    if (!query || [...query].length > USER_QUERY_MAX) return invalid();
    const mine = activityOf(row.id, time);
    if (mine.searches.length >= searchLimit) return rateLimited();
    mine.searches.push(time);
    const found = store.searchUsers(query, row.id, time, CHAT_CONVERSATION_LIMITS.userSearch * 2)
      .filter((user) => nameAllowed(user.username))
      .slice(0, CHAT_CONVERSATION_LIMITS.userSearch);
    return ok({ users: found.map(member) });
  }

  function socialGate(row, time) {
    const mine = activityOf(row.id, time);
    if (mine.socials.length >= socialLimit) return rateLimited();
    mine.socials.push(time);
    return null;
  }

  function findConversation(key, row) {
    const id = isConversationKey(key) ? conversationIdOf(key) : 0;
    const info = id && membersOf(id).has(row.id) ? store.conversationInfo(id) : null;
    return info ? { id, info } : { failure: conversationMissing() };
  }

  function findGroup(key, row) {
    const found = findConversation(key, row);
    return found.failure || found.info.kind === "group" ? found : { failure: invalid() };
  }

  function readMemberIds(value, row) {
    if (!Array.isArray(value) || value.length > CHAT_CONVERSATION_LIMITS.groupMembers * 2) return { failure: invalid() };
    const ids = [];
    for (const entry of value) {
      const { row: target, failure } = findTarget(entry);
      if (failure) return { failure };
      if (target.id !== row.id && !ids.includes(target.id)) ids.push(target.id);
    }
    return ids.length ? { ids } : { failure: invalid() };
  }

  function groupCap(ids, viewerId) {
    const limit = CHAT_CONVERSATION_LIMITS.groups;
    if (viewerId && store.groupCount(viewerId) >= limit) return httpError(429, "CHAT_GROUP_LIMIT", "you are in too many groups");
    const busy = ids.find((id) => store.groupCount(id) >= limit);
    return busy ? httpError(429, "CHAT_GROUP_LIMIT", "that user is in too many groups", { target: String(busy) }) : null;
  }

  function readGroupName(value) {
    const name = value === undefined || value === null ? "" : cleanConversationName(value);
    if (name === null) {
      return { failure: httpError(400, "CHAT_NAME_INVALID", `group names can be up to ${CHAT_CONVERSATION_LIMITS.name} characters`) };
    }
    return { name };
  }

  async function screenName(name, row, time) {
    if (name) {
      const verdict = await screenText(name);
      if (!verdict.allowed) {
        const until = strike(row, verdict.strikes, time);
        return httpError(422, "CHAT_NAME_BLOCKED", blockedNotice("group name", verdict.category), {
          category: verdict.category,
          ...(until && { until }),
        });
      }
    }
    return silenced(row);
  }

  function readMessageId(value) {
    const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  }

  function markRead(payload, row) {
    const { id, failure } = findConversation(payload.channel, row);
    if (failure) return failure;
    const messageId = readMessageId(payload.id);
    if (!messageId) return invalid();
    const stored = store.markRead(id, row.id, messageId);
    if (stored) sendTo(row.id, frame("read", { channel: conversationKey(id), id: String(stored) }));
    return ok();
  }

  function openDm(payload, row, time) {
    const { row: target, failure } = findTarget(payload.target);
    if (failure) return failure;
    if (target.id === row.id) return httpError(403, "CHAT_FORBIDDEN", "you can not message yourself");
    const limited = socialGate(row, time);
    if (limited) return limited;
    const opened = store.openDm(row.id, target.id, time);
    memberCache.delete(opened.id);
    if (opened.created) sendConversation(opened.id);
    else if (opened.unhidden) sendConversation(opened.id, [row.id]);
    return ok({ conversation: viewFor(opened.id, row.id) });
  }

  async function createGroup(payload, row, time) {
    const named = readGroupName(payload.name);
    if (named.failure) return named.failure;
    const picked = readMemberIds(payload.members, row);
    if (picked.failure) return picked.failure;
    if (picked.ids.length >= CHAT_CONVERSATION_LIMITS.groupMembers) return groupFull();
    const capped = groupCap(picked.ids, row.id);
    if (capped) return capped;
    const limited = socialGate(row, time);
    if (limited) return limited;
    const refused = await screenName(named.name, row, time);
    if (refused) return refused;
    const recapped = groupCap(picked.ids, row.id);
    if (recapped) return recapped;
    const id = store.createGroup(row.id, named.name, picked.ids, time);
    memberCache.delete(id);
    sendConversation(id);
    postNotice(id, row.id, { action: "create", ...(named.name && { name: named.name }) }, time);
    return ok({ conversation: viewFor(id, row.id) });
  }

  function groupAdd(payload, row, time) {
    const { id, failure } = findGroup(payload.channel, row);
    if (failure) return failure;
    const picked = readMemberIds(payload.members, row);
    if (picked.failure) return picked.failure;
    const current = membersOf(id);
    const added = picked.ids.filter((userId) => !current.has(userId));
    if (current.size + added.length > CHAT_CONVERSATION_LIMITS.groupMembers) return groupFull();
    const capped = groupCap(added);
    if (capped) return capped;
    const limited = socialGate(row, time);
    if (limited) return limited;
    if (added.length) {
      store.addMembers(id, added, time);
      memberCache.delete(id);
      for (const userId of added) postNotice(id, userId, { action: "add", by: nameOf(row) }, time);
      sendConversation(id);
    }
    return ok({ conversation: viewFor(id, row.id) });
  }

  function groupRemove(payload, row, time) {
    const { id, info, failure } = findGroup(payload.channel, row);
    if (failure) return failure;
    if (info.owner_id !== row.id) return httpError(403, "CHAT_FORBIDDEN", "only the group owner can remove people");
    const { row: target, failure: missing } = findTarget(payload.target);
    if (missing) return missing;
    if (target.id === row.id) return httpError(403, "CHAT_FORBIDDEN", "you can not do that to yourself");
    if (!membersOf(id).has(target.id)) return httpError(404, "CHAT_USER_NOT_FOUND", "that user is not in this group");
    const limited = socialGate(row, time);
    if (limited) return limited;
    store.leaveGroup(id, target.id);
    memberCache.delete(id);
    postNotice(id, target.id, { action: "remove", by: nameOf(row) }, time);
    sendConversation(id);
    dropConversationFor(target.id, id);
    revokeParties(target.id);
    return ok({ conversation: viewFor(id, row.id) });
  }

  async function groupRename(payload, row, time) {
    const { id, info, failure } = findGroup(payload.channel, row);
    if (failure) return failure;
    const named = readGroupName(payload.name);
    if (named.failure) return named.failure;
    if (named.name === (info.name ?? "")) return ok({ conversation: viewFor(id, row.id) });
    const limited = socialGate(row, time);
    if (limited) return limited;
    const refused = await screenName(named.name, row, time);
    if (refused) return refused;
    if (!membersOf(id).has(row.id)) return conversationMissing();
    store.renameConversation(id, named.name);
    postNotice(id, row.id, { action: "rename", ...(named.name && { name: named.name }) }, time);
    sendConversation(id);
    return ok({ conversation: viewFor(id, row.id) });
  }

  function leave(payload, row, time) {
    const { id, info, failure } = findConversation(payload.channel, row);
    if (failure) return failure;
    if (info.kind === "dm") {
      store.hideConversation(id, row.id);
      dropConversationFor(row.id, id);
      return ok();
    }
    const left = store.leaveGroup(id, row.id);
    memberCache.delete(id);
    if (left.deleted) endPartiesIn(conversationKey(id));
    else {
      postNotice(id, row.id, { action: "leave" }, time);
      sendConversation(id);
    }
    dropConversationFor(row.id, id);
    revokeParties(row.id);
    return ok();
  }

  function findParty(id, row) {
    const party = isPartyId(id) ? parties.get(id) : undefined;
    return party && canRead(party.target, row) ? { party } : { failure: partyMissing() };
  }

  function partyLimit() {
    return httpError(429, "CHAT_PARTY_LIMIT", `you already have ${CHAT_PARTY_LIMITS.hosted} watch parties running`);
  }

  function partyChannels(payload, row) {
    const channels = payload.channels === undefined ? [payload.channel] : payload.channels;
    if (!Array.isArray(channels) || !channels.length || channels.length > CHAT_CHANNELS.length) return { failure: invalid() };
    if (payload.channels !== undefined && channels.some((channel) => !isChatChannel(channel))) return { failure: invalid() };
    for (const channel of channels) {
      const failure = targetGate(channel, row);
      if (failure) return { failure };
    }
    return { channels: [...new Set(channels)].sort((a, b) => Number(a === "staff-chat") - Number(b === "staff-chat")) };
  }

  function postPartyInvites(party, channels, row, time) {
    const media = party.media;
    const invite = {
      id: party.id,
      title: media.title,
      kind: media.kind,
      ...(media.poster && { poster: media.poster }),
      ...(media.label && { label: media.label }),
    };
    return channels.map((channel) => {
      const message = insertInto({ channel, userId: row.id, text: "", time, party: invite });
      broadcast(frame("message", message), channel);
      return message;
    });
  }

  async function startParty(payload, row, ip, time) {
    const picked = partyChannels(payload, row);
    if (picked.failure) return picked.failure;
    const media = readPartyMedia(payload.path, payload.query);
    if (!media) return httpError(400, "CHAT_PARTY_INVALID", "that video can not be shared");
    if (parties.hostedBy(row.id) >= CHAT_PARTY_LIMITS.hosted) return partyLimit();
    const mine = activityOf(row.id, time);
    const source = sourceWindow(ip, time);
    if (mine.sends.length >= sendLimit || source.length >= sourceSendLimit) return rateLimited();
    mine.sends.push(time);
    source.push(time);
    sourceSends.set(ip, source);
    const refused = await screenMessage(media.title, row, time, picked.channels[0]);
    if (refused) return refused;
    const fresh = store.user(row.id);
    const lost = fresh ? partyChannels(payload, fresh).failure : httpError(403, "CHAT_CHANNEL_LOCKED", "only staff can post here");
    if (lost) return lost;
    if (parties.hostedBy(row.id) >= CHAT_PARTY_LIMITS.hosted) return partyLimit();
    const party = parties.create({ target: picked.channels[0], host: fresh, media });
    if (payload.position !== undefined) {
      const position = typeof payload.position === "number" && Number.isFinite(payload.position) ? payload.position : 0;
      party.playback = { paused: true, position: Math.min(PARTY_POSITION_MAX, Math.max(0, position)), at: time };
    }
    const current = parties.view(party);
    broadcast(frame("party", current), party.target);
    const [message] = postPartyInvites(party, picked.channels, row, time);
    return ok({ message, party: current });
  }

  function inviteParty(payload, row, ip, time) {
    const { party, failure } = findParty(payload.id, row);
    if (failure) return failure;
    const picked = partyChannels(payload, row);
    if (picked.failure) return picked.failure;
    if ((isConversationKey(party.target) || party.target === "staff-chat") && picked.channels.some((channel) => channel !== party.target)) {
      return httpError(403, "CHAT_FORBIDDEN", "private watch parties can only be shared in their original channel");
    }
    const mine = activityOf(row.id, time);
    const source = sourceWindow(ip, time);
    if (mine.sends.length >= sendLimit || source.length >= sourceSendLimit) return rateLimited();
    mine.sends.push(time);
    source.push(time);
    sourceSends.set(ip, source);
    const [message] = postPartyInvites(party, picked.channels, row, time);
    return ok({ message, party: parties.view(party) });
  }

  function partyGate(party, row, time) {
    if (!parties.isWatching(party, row.id)) return httpError(403, "CHAT_FORBIDDEN", "join the watch party first");
    if (party.control === "host" && party.host !== row.id) {
      return httpError(403, "CHAT_FORBIDDEN", "only the host can control this watch party");
    }
    const mine = activityOf(row.id, time);
    if (mine.states.length >= partyStateLimit) return rateLimited();
    mine.states.push(time);
    return null;
  }

  function partyState(payload, row, time) {
    const { party, failure } = findParty(payload.id, row);
    if (failure) return failure;
    if (typeof payload.paused !== "boolean" || typeof payload.position !== "number" || !Number.isFinite(payload.position)) {
      return invalid();
    }
    const denied = partyGate(party, row, time);
    if (denied) return denied;
    const position = Math.min(PARTY_POSITION_MAX, Math.max(0, payload.position));
    parties.setPlayback(party, { paused: payload.paused, position, at: time }, row);
    return ok({ party: parties.view(party) });
  }

  function partyMedia(payload, row, time) {
    const { party, failure } = findParty(payload.id, row);
    if (failure) return failure;
    const media = readPartyMedia(payload.path, payload.query);
    if (!media || media.title !== party.media.title) {
      return httpError(400, "CHAT_PARTY_INVALID", "a watch party can only switch episodes of the same title");
    }
    const denied = partyGate(party, row, time);
    if (denied) return denied;
    parties.setMedia(party, media, row);
    return ok({ party: parties.view(party) });
  }

  function partyHost(payload, row) {
    const found = findParty(payload.id, row);
    if (found.failure) return found;
    return found.party.host === row.id ? found : { failure: httpError(403, "CHAT_FORBIDDEN", "only the host can do that") };
  }

  function partyControl(payload, row) {
    const { party, failure } = partyHost(payload, row);
    if (failure) return failure;
    if (!isPartyControl(payload.control)) return invalid();
    if (party.control !== payload.control) parties.setControl(party, payload.control);
    return ok({ party: parties.view(party) });
  }

  function partyEnd(payload, row) {
    const { party, failure } = partyHost(payload, row);
    if (failure) return failure;
    parties.end(party);
    return ok();
  }

  async function partyChat(payload, row, ip, time) {
    const { party, failure } = findParty(payload.id, row);
    if (failure) return failure;
    if (!parties.isWatching(party, row.id)) return httpError(403, "CHAT_FORBIDDEN", "join the watch party first");
    const mine = activityOf(row.id, time);
    const source = sourceWindow(ip, time);
    if (mine.sends.length >= sendLimit || source.length >= sourceSendLimit) return rateLimited();
    const written = readText(payload);
    if (written.failure) return written.failure;
    mine.sends.push(time);
    source.push(time);
    sourceSends.set(ip, source);
    const refused = await screenMessage(written.text, row, time, party.target);
    if (refused) return refused;
    const fresh = store.user(row.id);
    if (!fresh || parties.get(party.id) !== party || !canRead(party.target, fresh) || !parties.isWatching(party, row.id)) {
      return partyMissing();
    }
    return ok({ message: parties.say(party, member(fresh), written.text) });
  }

  function partyInfo(url, row) {
    const { party, failure } = findParty(url.searchParams.get("id"), row);
    return failure ?? ok({ party: parties.view(party) });
  }

  function watchParty(url, row, signal) {
    const { party, failure } = findParty(url.searchParams.get("party"), row);
    if (failure) return reply(failure);
    if (parties.streamsOf(row.id) >= maxPartyStreamsPerUser) {
      return reply(httpError(429, "RATE_LIMITED", "too many watch party tabs are open"));
    }
    if (!parties.isWatching(party, row.id) && parties.watcherCount(party) >= partyWatchers) {
      return reply(httpError(409, "CHAT_PARTY_FULL", "that watch party is full"));
    }
    return parties.connect(party, streamUser(row), signal);
  }

  async function action(request, row, ip) {
    if (crossSite(request)) return httpError(403, "CHAT_REQUEST_DENIED", "this request is not allowed");
    const contentType = request.headers.get("content-type") || "";
    if (/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
      if (uploading.has(row.id)) return httpError(429, "CHAT_RATE_LIMITED", "slow down a little");
      const refused = silenced(row);
      if (refused) return refused;
      uploading.add(row.id);
      try {
        const bytes = await readBody(request, CHAT_UPLOAD_BYTES + BODY_MAX_BYTES);
        if (!bytes) return httpError(413, "CHAT_MEDIA_TOO_LARGE", "that file is too large", { kind: "file" });
        let form;
        try {
          form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
        } catch {
          return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
        }
        const payload = {};
        let file;
        for (const [key, value] of form) {
          if ((key === "image" || key === "media") && value instanceof Blob && !file) file = value;
          else if (["channel", "text", "nonce", "replyTo"].includes(key) && typeof value === "string" && !(key in payload)) payload[key] = value;
          else return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
        }
        if (!file) return httpError(400, "CHAT_MEDIA_INVALID", "that image could not be used");
        return await send(payload, row, ip, now(), file);
      } finally {
        uploading.delete(row.id);
      }
    }
    const length = request.headers.get("content-length");
    if (length && !(Number(length) <= BODY_MAX_BYTES)) return httpError(413, "CHAT_REQUEST_TOO_LARGE", "message is too large");
    const payload = await readJson(request);
    if (!payload) return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
    const time = now();
    row = store.guard.apply(store.user(row.id) ?? row, time);
    const refused = silenced(row);
    if (refused?.body.code === "CHAT_BANNED") return refused;
    const type = payload.type ?? "send";
    if (type === "delete") return remove(payload, row, time);
    if (["role", "timeout", "untimeout", "ban", "unban", "clearprofile"].includes(type)) {
      const { row: target, failure } =
        payload.targetName === undefined ? findTarget(payload.target) : findTargetByName(payload.targetName);
      if (failure) return failure;
      return moderateUser(row, target, type, payload, time);
    }
    if (type === "read") return markRead(payload, row);
    if (type === "dm") return openDm(payload, row, time);
    if (type === "leave") return leave(payload, row, time);
    if (type === "group-remove") return groupRemove(payload, row, time);
    if (type === "party-state") return partyState(payload, row, time);
    if (type === "party-media") return partyMedia(payload, row, time);
    if (type === "party-control") return partyControl(payload, row);
    if (type === "party-end") return partyEnd(payload, row);
    if (row.muted_until > time) return httpError(403, "CHAT_MUTED", "you are timed out for a bit", { until: row.muted_until });
    if (type === "send") return send(payload, row, ip, time);
    if (type === "party-chat") return partyChat(payload, row, ip, time);
    if (type === "edit") return edit(payload, row, time);
    if (type === "react") return react(payload, row, time);
    if (type === "typing") return typing(payload, row, time);
    if (type === "draft") return draft(payload, row, time);
    if (type === "group") return createGroup(payload, row, time);
    if (type === "group-add") return groupAdd(payload, row, time);
    if (type === "group-rename") return groupRename(payload, row, time);
    if (type === "party") return startParty(payload, row, ip, time);
    if (type === "party-invite") return inviteParty(payload, row, ip, time);
    return httpError(400, "CHAT_REQUEST_INVALID", "this request is not valid");
  }

  async function handleRequest(request, ip, browser) {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/chat\//, "");
    const method = request.method;
    const mediaRoute = MEDIA_ROUTE.exec(route);
    const attachmentRoute = ATTACHMENT_ROUTE.exec(route);
    const gifRoute = GIF_ROUTE.exec(route);
    if (attachmentRoute && (method === "GET" || method === "HEAD")) {
      const message = store.message(Number(attachmentRoute[1]));
      if (message && (isConversationKey(message.channel) || !canReadChannel("member", message.channel))) {
        const { row, failure } = await session(request, ip, browser);
        if (failure) return reply(failure);
        if (!canRead(message.channel, row)) return reply(httpError(404, "CHAT_MEDIA_NOT_FOUND", "that image is gone"));
      }
      return media(request, "message", attachmentRoute[1]);
    }
    if (mediaRoute?.[2] && (method === "GET" || method === "HEAD")) return media(request, mediaRoute[1], mediaRoute[2]);
    const known =
      (["message", "profile"].includes(route) && method === "POST") ||
      (mediaRoute && !mediaRoute[2] && method === "POST") ||
      (gifRoute && method === "GET") ||
      (["stream", "me", "history", "profile", "users", "party", "gifs"].includes(route) && method === "GET");
    if (!known) return reply(httpError(404, "CHAT_ROUTE_NOT_FOUND", "not found"));
    const { row, failure } = await session(request, ip, browser);
    if (failure) return reply(failure);
    if (route === "stream") return url.searchParams.has("party") ? watchParty(url, row, request.signal) : connect(row, request.signal);
    if (route === "me") return json(200, { viewer: viewer(row) });
    if (gifRoute) {
      const found = await gifs.media(gifRoute[1], url.searchParams.get("size"), row.id);
      return found.response ?? reply(found.failure);
    }
    let result;
    if (route === "history") result = history(url, row);
    else if (route === "users") result = users(url, row);
    else if (route === "gifs") result = await gifs.search(url, row.id);
    else if (route === "party") result = partyInfo(url, row);
    else if (route === "profile") result = method === "POST" ? await editProfile(request, row) : profile(url, row);
    else if (mediaRoute) result = await upload(request, mediaRoute[1], row);
    else result = await action(request, row, ip);
    return json(result.status, result.body);
  }

  async function handle(request, { ip = "unknown" } = {}) {
    const browser = store.guard.browser(request);
    const response = await handleRequest(request, ip, browser);
    if (browser.authenticated) response.headers.append("Set-Cookie", browser.cookie);
    return response;
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
    parties.close();
    memberCache.clear();
  }

  return { handle, control, close, count: () => streams.size };
}
