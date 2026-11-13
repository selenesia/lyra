import type Hls from "hls.js";
import { useEffect, useRef, useState, type MutableRef } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import { toast } from "../../core/ui/toast.ts";
import { partyMediaOf } from "../../features/chat/chatParty.ts";
import type { MediaStateHints } from "../../core/media/mediaState.ts";
import {
  CHAT_PARTY_LIMITS,
  displayName,
  isPartyControl,
  isPartyId,
  partyPlayerPath,
  partyPosition,
  type ChatMember,
  type ChatParty,
  type ChatPartyControl,
  type ChatPartyPath,
  type ChatPartyPlayback,
  type ChatChannel,
} from "../../features/chat/chatProtocol.ts";
import { cleanDuration, formatTime } from "./playerState.ts";

export const PARTY_SEEK_TOLERANCE = 1.5;
export const PARTY_DRIFT_TOLERANCE = 3;
const PARTY_DRIFT_INTERVAL = 4_000;
const PARTY_POST_SPACING = 500;
const PARTY_SETTLE_MS = 3_000;
const PARTY_OFFSET_SAMPLES = 8;
const PARTY_RETRY_MAX = 30_000;
const PARTY_TERMINAL_STATUSES = new Set([401, 403, 404, 409]);

export interface PartyMediaKey {
  series: string;
  episode: number;
}

export interface PartySyncInput {
  position: number;
  paused: boolean;
  ended: boolean;
  duration: number;
  target: number;
  targetPaused: boolean;
  tolerance: number;
}

export interface PartySyncAction {
  seek: number | null;
  paused: boolean | null;
}

export function readPartyParam(search: string | URLSearchParams): string | null {
  const id = new URLSearchParams(search).get("party");
  return isPartyId(id) ? id : null;
}

export function partyMediaQuery(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("party");
  return params.toString();
}

export function withPartyParam(url: string, base: string, id: string | null): string {
  const next = new URL(url, base);
  if (id) next.searchParams.set("party", id);
  else next.searchParams.delete("party");
  return next.href;
}

export function partyMediaKey(query: string): PartyMediaKey {
  const params = new URLSearchParams(query);
  const value = (key: string) => params.get(key)?.trim() ?? "";
  const count = (key: string) => (/^\d{1,5}$/.test(value(key)) ? Number(value(key)) : 0);
  const type = value("media_type");
  if ((type === "movie" || type === "tv") && value("tmdb_id")) {
    return type === "movie"
      ? { series: `movie:${value("tmdb_id")}`, episode: 0 }
      : { series: `tv:${value("tmdb_id")}:${count("season")}`, episode: count("episode") || 1 };
  }
  const ids = [value("anilist_id"), value("mal_id")];
  const identity = ids.some(Boolean) ? ids.join(":") : value("anikoto_episode_id");
  return { series: `anime:${identity}:${count("season") || 1}`, episode: count("episode") };
}

export function sameMedia(left: PartyMediaKey, right: PartyMediaKey): boolean {
  return left.series === right.series && left.episode === right.episode;
}

export function serverOffset(samples: readonly number[]): number {
  return samples.length ? Math.max(...samples) : 0;
}

export function addOffsetSample(samples: readonly number[], sample: number, limit = PARTY_OFFSET_SAMPLES): number[] {
  return Number.isFinite(sample) ? [...samples, sample].slice(-limit) : [...samples];
}

export function partySyncAction(input: PartySyncInput): PartySyncAction {
  const end = input.duration > 0 ? input.duration : Infinity;
  const goal = Math.max(0, Math.min(input.target, end));
  if (input.ended && goal >= end - input.tolerance) return { seek: null, paused: null };
  return {
    seek: Math.abs(input.position - goal) > input.tolerance ? goal : null,
    paused: input.paused === input.targetPaused ? null : input.targetPaused,
  };
}

export function playbackNoticeText(name: string, previous: ChatPartyPlayback, next: ChatPartyPlayback): string | null {
  if (previous.paused !== next.paused) return next.paused ? `${name} paused` : `${name} resumed`;
  return Math.abs(partyPosition(previous, next.at) - next.position) > PARTY_SEEK_TOLERANCE
    ? `${name} jumped to ${formatTime(next.position)}`
    : null;
}

export function mediaNoticeText(name: string, party: Pick<ChatParty, "label">): string {
  return party.label ? `${name} changed the episode to ${party.label}` : `${name} changed what's playing`;
}

export function watcherChanges(previous: readonly ChatMember[], next: readonly ChatMember[], viewer: string) {
  const before = new Set(previous.map((member) => member.author));
  const after = new Set(next.map((member) => member.author));
  return {
    joined: next.filter((member) => member.author !== viewer && !before.has(member.author)),
    left: previous.filter((member) => member.author !== viewer && !after.has(member.author)),
  };
}

export function watcherNoticeText(members: readonly ChatMember[], action: "joined" | "left"): string | null {
  const [first, second] = members;
  if (!first) return null;
  const subject = !second
    ? displayName(first)
    : members.length === 2
      ? `${displayName(first)} and ${displayName(second)}`
      : `${displayName(first)} and ${members.length - 1} others`;
  return `${subject} ${action} the party`;
}

export function mergeParty(current: ChatParty | null, incoming: ChatParty, fromStream: boolean): ChatParty {
  if (!current || current.id !== incoming.id) return incoming;
  if (incoming.playback.at < current.playback.at) {
    return { ...current, control: incoming.control, ...(fromStream && { watchers: incoming.watchers }) };
  }
  return fromStream ? incoming : { ...incoming, watchers: current.watchers };
}

export function partyFailureText(code: unknown, status: number): string {
  switch (code) {
    case "CHAT_PARTY_NOT_FOUND":
      return "this watch party has ended or is unavailable";
    case "CHAT_PARTY_FULL":
      return "this watch party is full";
    case "CHAT_PARTY_LIMIT":
      return "you already have too many watch parties running";
    case "CHAT_CHANNEL_LOCKED":
      return "you can't post in that channel";
    case "CHAT_PARTY_INVALID":
      return "that can't be played in this watch party";
    case "CHAT_RATE_LIMITED":
      return "slow down a little";
    case "CHAT_FORBIDDEN":
      return "only the host can control playback";
    case "CHAT_MUTED":
      return "you are timed out for a bit";
    case "CHAT_LOGIN_REQUIRED":
      return "make a cloudsync account to join watch parties";
    case "CHAT_BANNED":
    case "CHAT_USERNAME_BLOCKED":
      return "you can't join watch parties right now";
  }
  if (status === 401) return "sign in to chat to join watch parties";
  if (status === 404) return "this watch party has ended or is unavailable";
  return "the watch party is unreachable right now";
}

function isPlayback(value: unknown): value is ChatPartyPlayback {
  const playback = value as Partial<ChatPartyPlayback> | null;
  return (
    typeof playback === "object" && playback !== null &&
    typeof playback.paused === "boolean" &&
    typeof playback.position === "number" && Number.isFinite(playback.position) &&
    typeof playback.at === "number" && Number.isFinite(playback.at)
  );
}

export function isPartyState(value: unknown): value is ChatParty {
  const party = value as Partial<ChatParty> | null;
  return (
    typeof party === "object" && party !== null &&
    isPartyId(party.id) &&
    (party.path === "watch" || party.path === "anime") &&
    typeof party.query === "string" &&
    typeof party.title === "string" &&
    typeof party.host === "string" &&
    isPartyControl(party.control) &&
    isPlayback(party.playback) &&
    Array.isArray(party.watchers)
  );
}

export interface WatchPartyPlayer {
  path: ChatPartyPath;
  source: string;
  videoRef: MutableRef<HTMLVideoElement | null>;
  hlsRef: MutableRef<Hls | null>;
  playIntentRef: MutableRef<boolean>;
  playAfterSeekRef: MutableRef<boolean>;
  playRequestRef: MutableRef<number>;
  pendingSeekRef: MutableRef<number | null>;
  mediaHintsRef: MutableRef<MediaStateHints>;
  displayDurationRef: MutableRef<number>;
  syncMediaState: (patch?: MediaStateHints) => void;
  seekTo: (seconds: number) => void;
  followEpisode: (episode: number) => boolean;
}

interface PartyPlayerState {
  paused: boolean;
  ended: boolean;
  position: number;
  duration: number;
  ready: boolean;
  settling: boolean;
  source: string;
}

function readPlayer(player: WatchPartyPlayer): PartyPlayerState | null {
  const video = player.videoRef.current;
  if (!video) return null;
  return {
    paused: video.paused && !player.playIntentRef.current,
    ended: video.ended,
    position: player.pendingSeekRef.current ?? video.currentTime,
    duration: player.displayDurationRef.current || cleanDuration(video.duration),
    ready: player.mediaHintsRef.current.sourceReady === true && video.readyState >= HTMLMediaElement.HAVE_METADATA,
    settling: video.seeking || (!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA),
    source: player.source,
  };
}

function holdPlayer(player: WatchPartyPlayer) {
  player.playRequestRef.current += 1;
  player.playIntentRef.current = false;
  player.playAfterSeekRef.current = false;
}

function setPlayerPaused(player: WatchPartyPlayer, paused: boolean): Promise<boolean> {
  const video = player.videoRef.current;
  if (!video) return Promise.resolve(true);
  if (paused) {
    holdPlayer(player);
    video.pause();
    player.hlsRef.current?.pauseBuffering();
    return Promise.resolve(true);
  }
  const request = ++player.playRequestRef.current;
  player.playIntentRef.current = true;
  player.hlsRef.current?.resumeBuffering();
  return video.play().then(
    () => true,
    (error: unknown) => {
      if (request !== player.playRequestRef.current) return true;
      player.playIntentRef.current = false;
      player.playAfterSeekRef.current = false;
      player.hlsRef.current?.pauseBuffering();
      player.syncMediaState({ buffering: false, bufferingReason: null });
      return !(error instanceof DOMException && error.name === "NotAllowedError");
    },
  );
}

function releasePlayer(player: WatchPartyPlayer) {
  const video = player.videoRef.current;
  if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    void setPlayerPaused(player, false);
    return;
  }
  player.playIntentRef.current = true;
  player.playAfterSeekRef.current = true;
}

type PartyResult =
  | { ok: true; party: ChatParty | null }
  | { ok: false; status: number; code: unknown };

async function postParty(payload: Record<string, unknown>): Promise<PartyResult> {
  try {
    const response = await fetch(appPath("/api/chat/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, party: isPartyState(body.party) ? body.party : null };
    return { ok: false, status: response.status, code: body.code };
  } catch {
    return { ok: false, status: 0, code: undefined };
  }
}

function readEvent(event: Event): Record<string, unknown> | null {
  try {
    const data = JSON.parse((event as MessageEvent<string>).data) as unknown;
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface PartyView {
  active: boolean;
  party: ChatParty | null;
  viewer: string;
}

interface WatchPartyActions {
  allowIntent: () => boolean;
  catchUp: () => boolean;
  reportPlayback: () => void;
  reportMedia: (query: string, keepPlaying: boolean, navigateTo?: string) => Promise<boolean>;
  setControl: (control: ChatPartyControl) => void;
  copyInvite: () => void;
  leave: () => void;
  end: () => void;
}

export interface WatchParty extends WatchPartyActions {
  invite: (channels: ChatChannel[]) => Promise<boolean>;
  active: boolean;
  party: ChatParty | null;
  viewer: string;
  isHost: boolean;
  canControl: boolean;
  watchers: ChatMember[];
}

const IDLE_ACTIONS: WatchPartyActions = {
  allowIntent: () => true,
  catchUp: () => false,
  reportPlayback: () => undefined,
  reportMedia: () => Promise.resolve(true),
  setControl: () => undefined,
  copyInvite: () => undefined,
  leave: () => undefined,
  end: () => undefined,
};

const NO_WATCHERS: ChatMember[] = [];

function createPartySync(
  id: string,
  playerRef: MutableRef<WatchPartyPlayer>,
  setView: (view: PartyView) => void,
) {
  let party: ChatParty | null = null;
  let viewer = "";
  let active = true;
  let stopped = true;
  let events: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1_000;
  let driftTimer: ReturnType<typeof setInterval> | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let samples: number[] = [];
  let pendingApply = false;
  let awaitingSource: string | null = null;
  let synced = false;
  let blocked = false;
  let hostNotice = false;
  let navigating = false;
  let ending = false;
  let sending = false;
  let dirty = false;
  let sentAt = 0;
  let appliedAt = 0;
  let mediaPending = 0;
  let detachVideo: () => void = () => undefined;

  const clock = () => performance.timeOrigin + performance.now();
  const serverNow = () => clock() + serverOffset(samples);
  const sample = (now: unknown) => {
    if (typeof now === "number") samples = addOffsetSample(samples, now - clock());
  };
  const live = () => active && !stopped;
  const publish = () => {
    if (!stopped) setView({ active, party: active ? party : null, viewer });
  };
  const busy = () => sending || dirty || sendTimer !== null || mediaPending > 0;
  const controls = () => !party || party.control === "everyone" || party.host === viewer;
  const matchesLocal = (target: ChatParty) =>
    sameMedia(partyMediaKey(target.query), partyMediaKey(window.location.search));

  const closeStream = () => {
    if (!events) return;
    events.onerror = null;
    events.close();
    events = null;
  };
  const clearTimers = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (sendTimer !== null) clearTimeout(sendTimer);
    if (driftTimer !== null) clearInterval(driftTimer);
    retryTimer = null;
    sendTimer = null;
    driftTimer = null;
  };
  const finish = () => {
    if (!live()) return;
    active = false;
    dirty = false;
    closeStream();
    clearTimers();
    window.history.replaceState(
      window.history.state,
      "",
      withPartyParam(window.location.href, window.location.href, null),
    );
    if (!synced || (pendingApply && party && !party.playback.paused)) releasePlayer(playerRef.current);
    pendingApply = false;
    publish();
  };
  const fail = (result: { status: number; code: unknown }) => {
    if (result.code === "CHAT_PARTY_NOT_FOUND") {
      toast.info("the watch party ended");
      finish();
      return;
    }
    toast.error(partyFailureText(result.code, result.status));
  };
  const receive = (incoming: ChatParty, fromStream: boolean) => {
    const previous = party;
    const next = mergeParty(previous, incoming, fromStream);
    party = next;
    if (previous && fromStream) {
      const changes = watcherChanges(previous.watchers, next.watchers, viewer);
      for (const text of [watcherNoticeText(changes.joined, "joined"), watcherNoticeText(changes.left, "left")]) {
        if (text) toast.info(text);
      }
    }
    if (previous && previous.control !== next.control) hostNotice = false;
    publish();
    return { previous, next };
  };
  const accept = (result: PartyResult): boolean => {
    if (!live()) return false;
    if (result.ok) {
      if (result.party) receive(result.party, false);
      return true;
    }
    fail(result);
    return false;
  };

  const play = () => {
    void setPlayerPaused(playerRef.current, false).then((allowed) => {
      if (!live()) return;
      if (allowed) {
        blocked = false;
        return;
      }
      if (blocked) return;
      blocked = true;
      toast.info("press play to sync with the party");
    });
  };
  const hold = (target: ChatParty) => {
    pendingApply = true;
    if (target.playback.paused) void setPlayerPaused(playerRef.current, true);
    else holdPlayer(playerRef.current);
  };
  const follow = (target: ChatParty) => {
    const player = playerRef.current;
    const next = partyMediaKey(target.query);
    if (next.episode > 0 && next.series === partyMediaKey(window.location.search).series) {
      const source = player.source;
      if (player.followEpisode(next.episode)) {
        awaitingSource = source;
        hold(target);
        return;
      }
    }
    if (navigating) return;
    navigating = true;
    window.location.assign(appPath(partyPlayerPath(target)));
  };
  const reconcile = () => {
    if (!live() || !party || !viewer || busy() || navigating) return;
    if (!matchesLocal(party)) {
      follow(party);
      return;
    }
    const player = playerRef.current;
    const state = readPlayer(player);
    if (!state) return;
    if (!state.ready || (awaitingSource !== null && state.source === awaitingSource)) {
      hold(party);
      return;
    }
    awaitingSource = null;
    pendingApply = false;
    synced = true;
    const action = partySyncAction({
      ...state,
      target: partyPosition(party.playback, serverNow()),
      targetPaused: party.playback.paused,
      tolerance: PARTY_SEEK_TOLERANCE,
    });
    if (action.seek !== null) {
      player.seekTo(action.seek);
      appliedAt = Date.now();
    }
    if (action.paused === true) void setPlayerPaused(player, true);
    else if (action.paused === false) play();
  };
  const settle = () => {
    if (!busy()) reconcile();
  };

  const flush = async () => {
    if (!live() || sending || !dirty) return;
    const wait = sentAt + PARTY_POST_SPACING - Date.now();
    if (wait > 0) {
      sendTimer ??= setTimeout(() => {
        sendTimer = null;
        void flush();
      }, wait);
      return;
    }
    dirty = false;
    const state = readPlayer(playerRef.current);
    if (!party || !state || !synced || pendingApply || !matchesLocal(party)) {
      settle();
      return;
    }
    sending = true;
    sentAt = Date.now();
    const result = await postParty({
      type: "party-state",
      id,
      paused: state.paused,
      position: Math.max(0, state.position),
    });
    sending = false;
    accept(result);
    if (dirty) void flush();
    else settle();
  };

  const checkDrift = () => {
    if (
      !live() || !party || party.playback.paused || busy() || pendingApply || navigating ||
      Date.now() - appliedAt < PARTY_SETTLE_MS || !matchesLocal(party)
    ) return;
    const player = playerRef.current;
    const state = readPlayer(player);
    if (!state || !state.ready || state.settling || state.paused || state.ended) return;
    const action = partySyncAction({
      ...state,
      target: partyPosition(party.playback, serverNow()),
      targetPaused: false,
      tolerance: PARTY_DRIFT_TOLERANCE,
    });
    if (action.seek === null) return;
    player.seekTo(action.seek);
    appliedAt = Date.now();
  };

  const scheduleRetry = (task: () => void) => {
    if (!live() || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      task();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, PARTY_RETRY_MAX);
  };
  const diagnose = async () => {
    try {
      const response = await fetch(appPath(`/api/chat/party?id=${encodeURIComponent(id)}`), { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!live()) return;
      if (response.ok && isPartyState(body.party)) {
        const watchers = body.party.watchers;
        if (watchers.length >= CHAT_PARTY_LIMITS.watchers && !watchers.some((member) => member.author === viewer)) {
          toast.error(partyFailureText("CHAT_PARTY_FULL", 409));
          finish();
          return;
        }
      } else if (PARTY_TERMINAL_STATUSES.has(response.status)) {
        if (party && response.status === 404) toast.info("the watch party ended");
        else toast.error(partyFailureText(body.code, response.status));
        finish();
        return;
      }
    } catch {}
    scheduleRetry(connect);
  };
  const connect = () => {
    closeStream();
    if (!live()) return;
    const source = new EventSource(appPath(`/api/chat/stream?party=${encodeURIComponent(id)}`));
    events = source;
    let first = true;
    source.addEventListener("party", (event) => {
      const data = readEvent(event);
      if (!data || !isPartyState(data.party) || !live()) return;
      sample(data.now);
      retryDelay = 1_000;
      const { previous, next } = receive(data.party, true);
      const changed =
        first || !previous || next.playback.at > previous.playback.at ||
        !sameMedia(partyMediaKey(previous.query), partyMediaKey(next.query));
      first = false;
      if (changed) reconcile();
    });
    source.addEventListener("playback", (event) => {
      const data = readEvent(event);
      const playback = data?.playback;
      if (!data || !party || !isPlayback(playback) || !live()) return;
      sample(data.now);
      if (playback.at < party.playback.at) return;
      const previous = party.playback;
      party = { ...party, playback };
      publish();
      if (data.by !== viewer && typeof data.name === "string") {
        const text = playbackNoticeText(data.name, previous, playback);
        if (text) toast.info(text);
      }
      reconcile();
    });
    source.addEventListener("media", (event) => {
      const data = readEvent(event);
      if (!data || !isPartyState(data.party) || !live()) return;
      sample(data.now);
      const { next } = receive(data.party, true);
      if (data.by !== viewer && typeof data.name === "string") toast.info(mediaNoticeText(data.name, next));
      reconcile();
    });
    source.addEventListener("ended", () => {
      if (!live()) return;
      if (!ending) toast.info("the watch party ended");
      finish();
    });
    source.onerror = () => {
      if (events !== source || source.readyState !== EventSource.CLOSED) return;
      closeStream();
      void diagnose();
    };
  };
  const loadViewer = async () => {
    try {
      const response = await fetch(appPath("/api/chat/me"), { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!live()) return;
      const author = (body.viewer as { author?: unknown } | undefined)?.author;
      if (response.ok && typeof author === "string" && author) {
        viewer = author;
        publish();
        connect();
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        toast.error(partyFailureText(body.code, response.status));
        finish();
        return;
      }
    } catch {}
    scheduleRetry(() => void loadViewer());
  };

  const actions: WatchPartyActions = {
    allowIntent: () => {
      if (!live() || !party || !viewer || controls()) return true;
      if (!hostNotice) {
        hostNotice = true;
        toast.error("only the host can control playback");
      }
      reconcile();
      return false;
    },
    catchUp: () => {
      if (!live() || !party || !viewer || party.playback.paused || busy() || !matchesLocal(party)) return false;
      const player = playerRef.current;
      const state = readPlayer(player);
      if (!state || !state.paused) return false;
      if (!state.ready) return pendingApply;
      const end = state.duration > 0 ? state.duration : Infinity;
      const target = partyPosition(party.playback, serverNow());
      if (state.ended || target >= end - 1) return false;
      if (Math.abs(state.position - target) > PARTY_SEEK_TOLERANCE) {
        player.seekTo(target);
        appliedAt = Date.now();
      }
      play();
      return true;
    },
    reportPlayback: () => {
      if (!live() || !party || !viewer) return;
      dirty = true;
      void flush();
    },
    reportMedia: async (query, keepPlaying, navigateTo) => {
      if (!live() || !party || !viewer) {
        if (navigateTo !== undefined) window.location.assign(withPartyParam(navigateTo, window.location.href, live() ? id : null));
        return true;
      }
      mediaPending += 1;
      const accepted = accept(
        await postParty({ type: "party-media", id, path: playerRef.current.path, query: partyMediaQuery(query) }),
      );
      if (accepted && keepPlaying && live()) {
        accept(await postParty({ type: "party-state", id, paused: false, position: 0 }));
      }
      mediaPending -= 1;
      if (accepted && navigateTo !== undefined && live()) {
        navigating = true;
        window.location.assign(withPartyParam(navigateTo, window.location.href, id));
        return true;
      }
      settle();
      return accepted;
    },
    setControl: (control) => {
      if (!live() || !party || party.host !== viewer || party.control === control) return;
      void postParty({ type: "party-control", id, control }).then(accept);
    },
    copyInvite: () => {
      const url = party
        ? new URL(appPath(partyPlayerPath(party)), window.location.href).href
        : withPartyParam(window.location.href, window.location.href, id);
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(url))
        .then(
          () => toast.success("invite link copied"),
          () => toast.error("couldn't copy the invite link"),
        );
    },
    leave: () => finish(),
    end: () => {
      if (!live() || !party || party.host !== viewer) return;
      ending = true;
      void postParty({ type: "party-end", id }).then((result) => {
        if (!live()) return;
        if (result.ok) {
          finish();
          return;
        }
        ending = false;
        fail(result);
      });
    },
  };

  return {
    actions,
    start: () => {
      if (!active) return;
      stopped = false;
      const video = playerRef.current.videoRef.current;
      const onReady = () => {
        if (pendingApply) setTimeout(reconcile, 0);
      };
      video?.addEventListener("loadedmetadata", onReady);
      video?.addEventListener("canplay", onReady);
      detachVideo = () => {
        video?.removeEventListener("loadedmetadata", onReady);
        video?.removeEventListener("canplay", onReady);
      };
      driftTimer = setInterval(checkDrift, PARTY_DRIFT_INTERVAL);
      void loadViewer();
    },
    stop: () => {
      stopped = true;
      closeStream();
      clearTimers();
      detachVideo();
    },
  };
}

export function useWatchParty(initialId: string | null, player: WatchPartyPlayer): WatchParty {
  const playerRef = useRef(player);
  playerRef.current = player;
  const [view, setView] = useState<PartyView>(() => ({ active: Boolean(initialId), party: null, viewer: "" }));
  const [sync, setSync] = useState(() => (initialId ? createPartySync(initialId, playerRef, setView) : null));
  useEffect(() => {
    if (!sync) return;
    sync.start();
    return sync.stop;
  }, [sync]);
  const { party, viewer } = view;
  const isHost = Boolean(party && viewer && party.host === viewer);
  return {
    ...(sync?.actions ?? IDLE_ACTIONS),
    invite: async (channels) => {
      const media = partyMediaOf(window.location.href);
      if (!media) {
        toast.error("that video can't be shared");
        return false;
      }
      const current = view.active ? party : null;
      const result = await postParty(current
        ? { type: "party-invite", id: current.id, channels }
        : { type: "party", channels, path: media.path, query: media.query, position: playerRef.current.videoRef.current?.currentTime ?? 0 });
      if (!result.ok || !result.party) {
        toast.error(result.ok ? "the watch party is unreachable right now" : partyFailureText(result.code, result.status));
        return false;
      }
      if (!current) {
        const created = result.party;
        window.history.replaceState(window.history.state, "", withPartyParam(window.location.href, window.location.href, created.id));
        setView({ active: true, party: created, viewer: created.host });
        setSync(createPartySync(created.id, playerRef, setView));
      }
      toast.success(`watch party ${channels.length > 1 ? "invites" : "invite"} sent`);
      return true;
    },
    active: view.active,
    party,
    viewer,
    isHost,
    canControl: !view.active || !party || party.control === "everyone" || isHost,
    watchers: party?.watchers ?? NO_WATCHERS,
  };
}
