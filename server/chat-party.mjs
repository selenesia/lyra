import { randomBytes } from "crypto";

const EVENT_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

export function createPartyRegistry({ now, frame, pingFrame, pingMs, member, announce, delayMs, idleMs, maxMs }) {
  const parties = new Map();
  const streams = new Map();
  let heartbeat;

  const later = (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return timer;
  };
  const nameOf = (user) => user.display || user.username;
  const live = (party) => parties.get(party.id) === party;

  function watchers(party) {
    const byUser = new Map();
    for (const stream of party.streams.values()) if (!byUser.has(stream.user.id)) byUser.set(stream.user.id, stream.user);
    return [...byUser.values()];
  }

  function view(party) {
    return {
      ...party.media,
      id: party.id,
      target: party.target,
      host: String(party.host),
      hostName: party.hostName,
      control: party.control,
      playback: { ...party.playback },
      watchers: watchers(party).map(member),
      startedAt: party.startedAt,
    };
  }

  function sendAll(party, bytes) {
    for (const stream of [...party.streams.values()]) stream.send(bytes);
  }

  function publish(party) {
    const current = view(party);
    sendAll(party, frame("party", { party: current, now: now() }));
    announce(current);
  }

  function idle(party) {
    if (party.streams.size || party.idleTimer) return;
    party.idleTimer = later(() => end(party), idleMs);
  }

  function watchersChanged(party) {
    idle(party);
    if (party.announceTimer) return;
    party.announceTimer = later(() => {
      party.announceTimer = undefined;
      if (!live(party)) return;
      const signature = watchers(party).map((user) => user.id).join(",");
      if (signature === party.signature) return;
      party.signature = signature;
      publish(party);
    }, delayMs);
  }

  function clearTimers(party) {
    clearTimeout(party.idleTimer);
    clearTimeout(party.maxTimer);
    clearTimeout(party.announceTimer);
    party.idleTimer = party.maxTimer = party.announceTimer = undefined;
  }

  function create({ target, host, media }) {
    let id;
    do id = randomBytes(9).toString("base64url");
    while (parties.has(id));
    const time = now();
    const party = {
      id,
      target,
      host: host.id,
      hostName: nameOf(host),
      media,
      control: "everyone",
      playback: { paused: true, position: 0, at: time },
      startedAt: time,
      streams: new Map(),
      signature: "",
    };
    parties.set(id, party);
    party.maxTimer = later(() => end(party), maxMs);
    idle(party);
    return party;
  }

  function end(party) {
    if (!live(party)) return false;
    parties.delete(party.id);
    clearTimers(party);
    const ended = frame("ended", { now: now() });
    for (const stream of [...party.streams.values()]) {
      stream.send(ended);
      stream.close();
    }
    announce({ ...view(party), ended: true });
    return true;
  }

  function connect(party, user, signal) {
    const id = randomBytes(12).toString("base64url");
    let close = () => {};
    const body = new ReadableStream({
      start(controller) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        const stream = {
          user,
          party,
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
          party.streams.delete(id);
          signal?.removeEventListener("abort", abort);
          try {
            controller.close();
          } catch {}
          if (!streams.size) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          if (live(party)) watchersChanged(party);
        };
        streams.set(id, stream);
        party.streams.set(id, stream);
        signal?.addEventListener("abort", abort, { once: true });
        if (!heartbeat) {
          heartbeat = setInterval(() => {
            for (const entry of [...streams.values()]) entry.send(pingFrame);
          }, pingMs);
          heartbeat.unref?.();
        }
        clearTimeout(party.idleTimer);
        party.idleTimer = undefined;
        stream.send(frame("party", { party: view(party), now: now() }));
        watchersChanged(party);
      },
      cancel() {
        close();
      },
    }, { highWaterMark: 64 });
    return new Response(body, { headers: EVENT_HEADERS });
  }

  function setPlayback(party, playback, user) {
    party.playback = playback;
    sendAll(party, frame("playback", { playback: { ...playback }, by: String(user.id), name: nameOf(user), now: now() }));
  }

  function setMedia(party, media, user) {
    const time = now();
    party.media = media;
    party.playback = { paused: true, position: 0, at: time };
    sendAll(party, frame("media", { party: view(party), by: String(user.id), name: nameOf(user), now: time }));
    publish(party);
  }

  function setControl(party, control) {
    party.control = control;
    publish(party);
  }

  function closeStreams(userId, lost) {
    for (const stream of [...streams.values()]) if (stream.user.id === userId && lost(stream.party)) stream.close();
  }

  function refresh(userId, patch) {
    for (const stream of streams.values()) if (stream.user.id === userId) stream.user = { ...stream.user, ...patch };
  }

  function close() {
    const all = [...parties.values()];
    parties.clear();
    for (const party of all) clearTimers(party);
    for (const stream of [...streams.values()]) stream.close();
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  return {
    create,
    end,
    connect,
    view,
    setPlayback,
    setMedia,
    setControl,
    closeStreams,
    refresh,
    close,
    get: (id) => parties.get(id),
    list: () => [...parties.values()],
    hostedBy: (userId) => [...parties.values()].filter((party) => party.host === userId).length,
    isWatching: (party, userId) => [...party.streams.values()].some((stream) => stream.user.id === userId),
    watcherCount: (party) => watchers(party).length,
    streamsOf: (userId) => [...streams.values()].filter((stream) => stream.user.id === userId).length,
  };
}
