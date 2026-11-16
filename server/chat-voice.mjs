import { randomBytes } from "crypto";
import { CHAT_VOICE_CHANNELS } from "../src/features/chat/chatProtocol.ts";

const EVENT_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

export function createVoiceRegistry({
  now,
  frame,
  pingFrame,
  pingMs,
  member,
  announce,
  delayMs,
  capacity,
  graceMs,
  staleMs,
  queueLimit,
}) {
  const sessions = new Map();
  const byUser = new Map();
  const startedAt = new Map();
  const announcing = new Map();
  const retryFrame = new TextEncoder().encode("retry: 1500\n\n");
  let order = 0;
  let heartbeat;
  let sweeper;

  const later = (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return timer;
  };
  const live = (session) => sessions.get(session.id) === session;

  function peerView(session) {
    return {
      ...member(session.user),
      session: session.id,
      seq: session.seq,
      muted: session.muted,
      deafened: session.deafened,
    };
  }

  function membersOf(channel) {
    return [...sessions.values()].filter((session) => session.channel === channel).sort((a, b) => a.seq - b.seq);
  }

  function roomView(channel) {
    return { channel, startedAt: startedAt.get(channel) ?? null, members: membersOf(channel).map(peerView) };
  }

  function announceSoon(channel) {
    if (announcing.has(channel)) return;
    announcing.set(channel, later(() => {
      announcing.delete(channel);
      announce(roomView(channel));
    }, delayMs));
  }

  function deliver(session, bytes) {
    if (session.stream) {
      session.stream.send(bytes);
      return;
    }
    session.queue.push(bytes);
    if (session.queue.length > queueLimit) session.queue.shift();
  }

  function sendChannel(channel, bytes, except) {
    for (const session of [...sessions.values()]) if (session.channel === channel && session !== except) deliver(session, bytes);
  }

  function startTimers() {
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const session of [...sessions.values()]) session.stream?.send(pingFrame);
      }, pingMs);
      heartbeat.unref?.();
    }
    if (!sweeper) {
      sweeper = setInterval(() => {
        const time = now();
        for (const session of [...sessions.values()]) if (time - session.seenAt > staleMs) end(session, "CHAT_VOICE_EXPIRED");
      }, Math.min(10_000, Math.max(250, staleMs / 3)));
      sweeper.unref?.();
    }
  }

  function stopTimers() {
    if (sessions.size) return;
    clearInterval(heartbeat);
    clearInterval(sweeper);
    heartbeat = sweeper = undefined;
  }

  function armGrace(session) {
    clearTimeout(session.graceTimer);
    session.graceTimer = later(() => {
      if (live(session) && !session.stream) end(session, "CHAT_VOICE_EXPIRED");
    }, graceMs);
  }

  function join(user, channel, { muted = false, deafened = false } = {}) {
    const previous = byUser.get(user.id);
    const taken = membersOf(channel).filter((session) => session !== previous).length;
    if (taken >= capacity) return { full: true };
    const channelStartedAt = startedAt.get(channel) ?? now();
    if (previous) end(previous, "CHAT_VOICE_MOVED");
    startedAt.set(channel, channelStartedAt);
    let id;
    do id = randomBytes(12).toString("base64url");
    while (sessions.has(id));
    const session = {
      id,
      user,
      channel,
      seq: ++order,
      muted: muted || deafened,
      deafened,
      stream: null,
      queue: [],
      graceTimer: undefined,
      seenAt: now(),
    };
    sessions.set(id, session);
    byUser.set(user.id, session);
    startTimers();
    armGrace(session);
    sendChannel(channel, frame("voice-peer", { action: "join", peer: peerView(session) }), session);
    announceSoon(channel);
    return { session };
  }

  function end(session, code) {
    if (!live(session)) return false;
    sessions.delete(session.id);
    if (!membersOf(session.channel).length) startedAt.delete(session.channel);
    if (byUser.get(session.user.id) === session) byUser.delete(session.user.id);
    clearTimeout(session.graceTimer);
    const stream = session.stream;
    session.stream = null;
    session.queue = [];
    if (stream) {
      if (code) stream.send(frame("voice-end", { code }));
      stream.close();
    }
    sendChannel(session.channel, frame("voice-peer", { action: "leave", session: session.id }));
    announceSoon(session.channel);
    stopTimers();
    return true;
  }

  function connect(session, signal) {
    let close = () => {};
    const body = new ReadableStream({
      start(controller) {
        if (signal?.aborted || !live(session)) {
          controller.close();
          return;
        }
        const stream = {
          send(bytes) {
            if (controller.desiredSize > 0) controller.enqueue(bytes);
            else close();
          },
          close: () => close(),
        };
        const abort = () => close();
        let closed = false;
        close = () => {
          if (closed) return;
          closed = true;
          signal?.removeEventListener("abort", abort);
          try {
            controller.close();
          } catch {}
          if (session.stream !== stream) return;
          session.stream = null;
          if (live(session)) armGrace(session);
        };
        const replaced = session.stream;
        session.stream = stream;
        replaced?.close();
        clearTimeout(session.graceTimer);
        session.graceTimer = undefined;
        session.seenAt = now();
        signal?.addEventListener("abort", abort, { once: true });
        stream.send(retryFrame);
        stream.send(frame("voice-session", {
          self: peerView(session),
          channel: session.channel,
          peers: membersOf(session.channel).filter((entry) => entry !== session).map(peerView),
          now: now(),
        }));
        const queued = session.queue;
        session.queue = [];
        for (const bytes of queued) stream.send(bytes);
      },
      cancel() {
        close();
      },
    }, { highWaterMark: 64 });
    return new Response(body, { headers: EVENT_HEADERS });
  }

  function relay(from, to, data) {
    if (!live(from) || !live(to) || from === to || from.channel !== to.channel) return false;
    deliver(to, frame("voice-signal", { from: from.id, author: String(from.user.id), data }));
    return true;
  }

  function setState(session, muted, deafened) {
    const nextMuted = muted || deafened;
    if (session.muted === nextMuted && session.deafened === deafened) return;
    session.muted = nextMuted;
    session.deafened = deafened;
    sendChannel(session.channel, frame("voice-peer", { action: "update", peer: peerView(session) }));
    announceSoon(session.channel);
  }

  function touch(session) {
    session.seenAt = now();
  }

  function refresh(userId, user) {
    const session = byUser.get(userId);
    if (!session) return;
    session.user = user;
    sendChannel(session.channel, frame("voice-peer", { action: "update", peer: peerView(session) }));
    announceSoon(session.channel);
  }

  function drop(userId, code) {
    const session = byUser.get(userId);
    return session ? end(session, code) : false;
  }

  function close() {
    for (const timer of announcing.values()) clearTimeout(timer);
    announcing.clear();
    for (const session of [...sessions.values()]) {
      sessions.delete(session.id);
      clearTimeout(session.graceTimer);
      session.stream?.close();
    }
    byUser.clear();
    startedAt.clear();
    stopTimers();
  }

  return {
    join,
    end,
    connect,
    relay,
    setState,
    touch,
    refresh,
    drop,
    close,
    get: (id) => sessions.get(id),
    of: (userId) => byUser.get(userId),
    list: () => CHAT_VOICE_CHANNELS.map(roomView),
    users: () => [...byUser.keys()],
  };
}
