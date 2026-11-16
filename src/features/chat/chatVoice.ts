import { useEffect } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { fetchServiceMetadata } from "../../core/runtime/serviceMetadata.ts";
import { uiSignal, useUiSignal } from "../../core/ui/uiSignals.ts";
import {
  CHAT_VOICE_LIMITS,
  isVoiceSession,
  readVoiceSignal,
  type ChatVoiceCandidate,
  type ChatVoiceChannel,
  type ChatVoicePeer,
  type ChatVoiceSignal,
} from "./chatProtocol.ts";

export type VoicePhase = "idle" | "joining" | "connected" | "reconnecting";
export type VoiceQuality = "good" | "fair" | "poor";

export interface VoiceSnapshot {
  channel: ChatVoiceChannel | null;
  phase: VoicePhase;
  peers: readonly ChatVoicePeer[];
  connecting: readonly string[];
  muted: boolean;
  deafened: boolean;
  micMissing: boolean;
  quality: VoiceQuality | null;
  ping: number | null;
  error: string | null;
}

interface IceSetup {
  servers: RTCIceServer[];
  relay: boolean;
}

interface VoiceReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}


const PREFERENCES_STORAGE = "lyra-voice";
const LOCAL_MUTES_STORAGE = "lyra-voice-muted";
const MIC: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const STATS_MS = 2_000;
const SPEAKING_MS = 100;
const SPEAKING_LEVEL = 0.02;
const SELF_LEVEL = 0.012;
const SPEAKING_HOLD_MS = 350;
const SOURCE_FRESH_MS = 500;
const CANDIDATE_FLUSH_MS = 30;
const CONNECT_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 2_500;
const RESTART_MAX_MS = 20_000;
const REJOIN_LIMIT = 3;
const REJOIN_DELAY_MS = 500;
const OFFLINE_RETRY_MS = 3_000;
const BITRATE_MIN = 12_000;
const MIC_BLOCKED = negativeMessage("microphone access is blocked, you can still listen");
const WANTED_OPUS: Record<string, string> ={ useinbandfec: "1", usedtx: "1", stereo: "0", "sprop-stereo": "0" };

function readPreferences(): { muted: boolean; deafened: boolean } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE) || "{}");
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return { muted: value.muted === true, deafened: value.deafened === true };
  } catch {
    return { muted: false, deafened: false };
  }
}

function readLocalMutes(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_MUTES_STORAGE) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const preferences = readPreferences();

export const voiceState = uiSignal<VoiceSnapshot>({
  channel: null,
  phase: "idle",
  peers: [],
  connecting: [],
  muted: preferences.muted,
  deafened: preferences.deafened,
  micMissing: false,
  quality: null,
  ping: null,
  error: null,
});
export const voiceSpeaking = uiSignal<ReadonlySet<string>>(new Set());
export const voiceLocalMutes = uiSignal<ReadonlySet<string>>(readLocalMutes());

let active: VoiceCall | null = null;
let blocked: ReadonlySet<string> = new Set();
let speakingWatchers = 0;

function update(patch: Partial<VoiceSnapshot>): void {
  voiceState.value = { ...voiceState.value, ...patch };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const entry of left) if (!right.has(entry)) return false;
  return true;  
}

function failureText(code: unknown): string {
  switch (code) {
    case "CHAT_VOICE_FULL":
      return negativeMessage("that voice channel is full");
    case "CHAT_MUTED":
      return negativeMessage("you are timed out for a bit");
    case "CHAT_BANNED":
      return negativeMessage("you are banned from chat");
    case "CHAT_RATE_LIMITED":
      return negativeMessage("slow down a little");
    case "CHAT_LOGIN_REQUIRED":
      return negativeMessage("log in to use voice");
    case "CHAT_VOICE_MOVED":
      return "voice moved to another tab";
    case "CHAT_VOICE_KICKED":
      return negativeMessage("a staff member removed you from voice");
    default:
      return negativeMessage("voice is unavailable right now");
  }
}

async function voicePost(body: Record<string, unknown>, keepalive = false): Promise<VoiceReply> {
  try {
    const response = await fetch(appPath("/api/chat/voice"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      keepalive,
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

async function iceSetup(): Promise<IceSetup | null> {
  const metadata = await fetchServiceMetadata();
  const turn = metadata?.turn;
  if (!turn || typeof turn !== "object") return null;
  const config = turn as Record<string, unknown>;
  const servers = (Array.isArray(config.iceServers) ? config.iceServers : []).filter(
    (server): server is RTCIceServer => !!server && typeof server === "object" && "urls" in server,
  );
  const relay = config.forceRelay === true;
  return relay && !servers.length ? null : { servers, relay };
}

function tuneOpus(sdp: string): string {
  const rtpmap = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!rtpmap) return sdp;
  const type = rtpmap[1];
  const fmtp = new RegExp(`a=fmtp:${type} ([^\\r\\n]*)`).exec(sdp);
  const params = new Map<string, string>();
  for (const part of (fmtp?.[1] ?? "").split(";")) {
    const entry = part.trim();
    if (!entry) continue;
    const split = entry.indexOf("=");
    params.set(split < 0 ? entry : entry.slice(0, split), split < 0 ? "" : entry.slice(split + 1));
  }
  for (const [key, value] of Object.entries(WANTED_OPUS)) params.set(key, value);
  const line = `a=fmtp:${type} ${[...params].map(([key, value]) => (value ? `${key}=${value}` : key)).join(";")}`;
  return fmtp ? sdp.replace(fmtp[0], line) : sdp.replace(rtpmap[0], `${rtpmap[0]}\r\n${line}`);
}

function preferOpus(transceiver: RTCRtpTransceiver): void {
  try {
    const codecs = RTCRtpReceiver.getCapabilities?.("audio")?.codecs ?? [];
    const opus = codecs.filter((codec) => codec.mimeType.toLowerCase() === "audio/opus");
    if (opus.length) transceiver.setCodecPreferences(opus);
  } catch {}
}

function sourceAge(timestamp: number): number {
  const now = performance.now();
  return Math.min(Math.abs(now - timestamp), Math.abs(performance.timeOrigin + now - timestamp));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function silencedAuthor(author: string): boolean {
  return voiceState.value.deafened || voiceLocalMutes.value.has(author) || blocked.has(author);
}

class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly audio = new Audio();
  readonly session: string;
  readonly offerer: boolean;
  author: string;
  sender: RTCRtpSender | null = null;
  closed = false;
  rtt: number | null = null;
  loss = 0;
  bitrate = 0;
  private chain: Promise<void> = Promise.resolve();
  private outbox: ChatVoiceCandidate[] = [];
  private remoteCandidates: ChatVoiceCandidate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private recoverTimer: ReturnType<typeof setTimeout> | undefined;
  private restarts = 0;
  private lostBefore = 0;
  private receivedBefore = 0;

  constructor(private readonly call: VoiceCall, session: string, author: string, offerer: boolean) {
    this.session = session;
    this.author = author;
    this.offerer = offerer;
    this.pc = new RTCPeerConnection({
      iceServers: call.ice.servers,
      iceTransportPolicy: call.ice.relay ? "relay" : "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    this.audio.autoplay = true;
    this.applyOutput();
    this.pc.ontrack = ({ track, streams }) => {
      this.audio.srcObject = streams[0] ?? new MediaStream([track]);
      void this.audio.play().catch(() => call.awaitGesture());
    };
    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate) return;
      this.outbox.push({ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex });
      if (this.outbox.length >= CHAT_VOICE_LIMITS.candidates) this.flush();
      else this.flushTimer ??= setTimeout(() => this.flush(), CANDIDATE_FLUSH_MS);
    };
    this.pc.onconnectionstatechange = () => this.watch();
    this.armRecover(CONNECT_TIMEOUT_MS);
    if (offerer) {
      const transceiver = this.pc.addTransceiver(call.track ?? "audio", {
        direction: "sendrecv",
        streams: call.mic ? [call.mic] : [],
      });
      preferOpus(transceiver);
      this.sender = transceiver.sender;
      this.enqueue(() => this.offer(false));
    }
  }

  get connected(): boolean {
    return this.pc.connectionState === "connected";
  }

  receive(signal: ChatVoiceSignal): void {
    this.enqueue(() => this.handle(signal));
  }

  applyOutput(): void {
    this.audio.muted = silencedAuthor(this.author);
  }

  replay(): void {
    if (this.audio.srcObject && this.audio.paused) void this.audio.play().catch(() => {});
  }

  kick(): void {
    if (!this.closed && !this.connected) this.armRecover(0);
  }

  level(): number {
    const receiver = this.pc.getReceivers()[0];
    if (!receiver?.getSynchronizationSources) return 0;
    let level = 0;
    for (const source of receiver.getSynchronizationSources()) {
      if (typeof source.audioLevel === "number" && sourceAge(source.timestamp) < SOURCE_FRESH_MS) level = Math.max(level, source.audioLevel);
    }
    return level;
  }

  async sample(cap: number): Promise<void> {
    if (this.closed || !this.connected) {
      this.rtt = null;
      return;
    }
    const report = await this.pc.getStats();
    let rtt: number | null = null;
    let sendLoss = 0;
    let lost = 0;
    let received = 0;
    let available = 0;
    report.forEach((stat) => {
      if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") {
        if (typeof stat.currentRoundTripTime === "number") rtt = stat.currentRoundTripTime;
        if (typeof stat.availableOutgoingBitrate === "number") available = stat.availableOutgoingBitrate;
      } else if (stat.type === "remote-inbound-rtp" && stat.kind === "audio") {
        if (typeof stat.fractionLost === "number") sendLoss = stat.fractionLost;
        if (rtt === null && typeof stat.roundTripTime === "number") rtt = stat.roundTripTime;
      } else if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        lost = typeof stat.packetsLost === "number" ? stat.packetsLost : 0;
        received = typeof stat.packetsReceived === "number" ? stat.packetsReceived : 0;
      }
    });
    const lostDelta = Math.max(0, lost - this.lostBefore);
    const receivedDelta = Math.max(0, received - this.receivedBefore);
    this.lostBefore = lost;
    this.receivedBefore = received;
    const receiveLoss = lostDelta + receivedDelta >= 10 ? lostDelta / (lostDelta + receivedDelta) : 0;
    const roundTrip: number = rtt ?? 0;
    this.rtt = rtt;
    this.loss = Math.max(sendLoss, receiveLoss);
    let next = this.bitrate || cap;
    if (sendLoss > 0.1 || roundTrip > 0.5) next *= 0.7;
    else if (sendLoss > 0.03 || roundTrip > 0.3) next *= 0.85;
    else if (sendLoss < 0.01) next = next * 1.1 + 1_000;
    if (available > 0) next = Math.min(next, available * 0.8);
    next = Math.round(Math.min(cap, Math.max(BITRATE_MIN, next)) / 1_000) * 1_000;
    if (!this.bitrate || Math.abs(next - this.bitrate) >= 2_000) await this.tuneSender(next);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.recoverTimer);
    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    this.audio.pause();
    this.audio.srcObject = null;
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch(() => {});
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.closed || !this.outbox.length) return;
    void this.call.signal(this, { kind: "candidates", candidates: this.outbox.splice(0) });
  }

  private async handle(signal: ChatVoiceSignal): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    if (signal.kind === "offer") {
      if (this.offerer) return;
      await pc.setRemoteDescription({ type: "offer", sdp: tuneOpus(signal.sdp) });
      if (!this.sender) {
        const transceiver = pc.getTransceivers()[0];
        if (transceiver) {
          transceiver.direction = "sendrecv";
          if (this.call.track) await transceiver.sender.replaceTrack(this.call.track);
          if (this.call.mic) transceiver.sender.setStreams?.(this.call.mic);
          preferOpus(transceiver);
          this.sender = transceiver.sender;
        }
      }
      await pc.setLocalDescription(await pc.createAnswer());
      const sdp = pc.localDescription?.sdp;
      if (sdp) void this.call.signal(this, { kind: "answer", sdp });
      await this.addRemoteCandidates();
      return;
    }
    if (signal.kind === "answer") {
      if (!this.offerer || pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: tuneOpus(signal.sdp) });
      await this.addRemoteCandidates();
      return;
    }
    if (signal.kind === "restart") {
      if (this.offerer) await this.restart();
      return;
    }
    if (signal.kind !== "candidates") return;
    this.remoteCandidates.push(...signal.candidates);
    if (pc.remoteDescription) await this.addRemoteCandidates();
  }

  private async addRemoteCandidates(): Promise<void> {
    for (const candidate of this.remoteCandidates.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  private async offer(iceRestart: boolean): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
    if (pc.signalingState !== "stable") return;
    await pc.setLocalDescription(await pc.createOffer(iceRestart ? { iceRestart: true } : {}));
    const sdp = pc.localDescription?.sdp;
    if (sdp) void this.call.signal(this, { kind: "offer", sdp });
  }

  private async restart(): Promise<void> {
    this.restarts += 1;
    await this.offer(true);
  }

  private recover(): void {
    this.recoverTimer = undefined;
    if (this.closed || this.connected) return;
    if (this.offerer) this.enqueue(() => this.restart());
    else {
      this.restarts += 1;
      void this.call.signal(this, { kind: "restart" });
    }
    this.armRecover(Math.min(RESTART_MAX_MS, 4_000 * 2 ** Math.min(this.restarts, 3)));
  }

  private armRecover(ms: number): void {
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recover(), ms);
  }

  private watch(): void {
    const state = this.pc.connectionState;
    if (state === "connected") {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = undefined;
      this.restarts = 0;
      void this.tuneSender(this.bitrate || this.call.bitrateCap());
    } else if (state === "disconnected") this.armRecover(DISCONNECT_GRACE_MS);
    else if (state === "failed") this.armRecover(0);
    this.call.linksChanged();
  }

  private async tuneSender(target: number): Promise<void> {
    const sender = this.sender;
    if (!sender || this.closed) return;
    const parameters = sender.getParameters();
    const encoding = parameters.encodings?.[0];
    if (!encoding) return;
    encoding.maxBitrate = target;
    encoding.priority = "high";
    encoding.networkPriority = "high";
    this.bitrate = target;
    await sender.setParameters(parameters).catch(() => {});
  }
}

class VoiceCall {
  readonly channel: ChatVoiceChannel;
  ice: IceSetup = { servers: [], relay: true };
  mic: MediaStream | null = null;
  track: MediaStreamTrack | null = null;
  ended = false;
  private session = "";
  private micPending = false;
  private seq = 0;
  private author: string | null = null;
  private readonly links = new Map<string, PeerLink>();
  private readonly peers = new Map<string, ChatVoicePeer>();
  private events: EventSource | null = null;
  private rejoins = 0;
  private rejoining = false;
  private serverRtt: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private speakingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly samples = new Float32Array(512);
  private readonly heard = new Map<string, number>();
  private gestureWaiting = false;

  constructor(channel: ChatVoiceChannel) {
    this.channel = channel;
    try {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = this.samples.length;
    } catch {
      this.context = null;
      this.analyser = null;
    }
  }

  async start(): Promise<void> {
    update({ channel: this.channel, phase: "joining", peers: [], connecting: [], error: null, quality: null, ping: null, micMissing: false });
    addEventListener("pagehide", this.onPageHide);
    const ice = await iceSetup().catch(() => null);
    if (this.ended || !ice) {
      if (!this.ended) this.finish(failureText(undefined));
      return;
    }
    const { muted, deafened } = voiceState.value;
    const joined = await voicePost({ type: "join", channel: this.channel, muted, deafened });
    const voice = joined.body.voice as { session?: unknown } | undefined;
    const session = joined.ok && isVoiceSession(voice?.session) ? voice.session : null;
    if (this.ended || !session) {
      if (session) void voicePost({ type: "leave", session }, true);
      if (!this.ended) this.finish(failureText(joined.body.code));
      return;
    }
    this.session = session;
    this.ice = ice;
    if (muted !== voiceState.value.muted || deafened !== voiceState.value.deafened) this.applyPreferences();
    else if (!muted && !deafened) void this.retryMic();
    this.open();
    this.pingTimer = setInterval(() => void this.ping(), CHAT_VOICE_LIMITS.pingMs);
    this.statsTimer = setInterval(() => void this.sampleAll(), STATS_MS);
    addEventListener("online", this.onOnline);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    this.watchSpeaking();
  }

  leave(): void {
    if (this.ended) return;
    if (this.session) void voicePost({ type: "leave", session: this.session }, true);
    this.finish(null);
  }

  finish(error: string | null): void {
    if (this.ended) return;
    this.ended = true;
    if (active === this) active = null;
    clearInterval(this.pingTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.speakingTimer);
    clearTimeout(this.retryTimer);
    removeEventListener("pagehide", this.onPageHide);
    removeEventListener("online", this.onOnline);
    removeEventListener("pointerdown", this.onGesture, true);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.events?.close();
    this.events = null;
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.peers.clear();
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.track?.removeEventListener("ended", this.onTrackEnded);
    this.mic = null;
    this.track = null;
    this.source?.disconnect();
    const context = this.context;
    this.context = null;
    if (context) setTimeout(() => void context.close().catch(() => {}), 400);
    update({ channel: null, phase: "idle", peers: [], connecting: [], micMissing: false, quality: null, ping: null, error });
    voiceSpeaking.value = new Set();
  }

  applyPreferences(): void {
    const { muted, deafened } = voiceState.value;
    if (this.track) this.track.enabled = !muted && !deafened;
    for (const link of this.links.values()) link.applyOutput();
    if (!this.session || this.ended) return;
    if (!muted && !deafened && (!this.track || this.track.readyState === "ended")) void this.retryMic();
    void voicePost({ type: "state", session: this.session, muted: muted || deafened, deafened });
  }

  applyOutput(): void {
    for (const link of this.links.values()) link.applyOutput();
  }

  async retryMic(): Promise<void> {
    if (this.ended || this.micPending || voiceState.value.muted || voiceState.value.deafened) return;
    this.micPending = true;
    const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: MIC }).catch(() => null);
    this.micPending = false;
    if (this.ended || voiceState.value.muted || voiceState.value.deafened) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      return;
    }
    if (stream) this.useMic(stream);
    else update({ micMissing: true, error: MIC_BLOCKED });
  }

  watchSpeaking(): void {
    clearInterval(this.speakingTimer);
    this.speakingTimer = undefined;
    if (this.ended) return;
    if (!speakingWatchers || document.visibilityState === "hidden") {
      void this.context?.suspend().catch(() => {});
      if (voiceSpeaking.value.size) voiceSpeaking.value = new Set();
      return;
    }
    void this.context?.resume().catch(() => {});
    this.speakingTimer = setInterval(() => this.pollSpeaking(), SPEAKING_MS);
  }

  bitrateCap(): number {
    const others = this.links.size;
    return others <= 2 ? 40_000 : others <= 4 ? 32_000 : others <= 6 ? 28_000 : 24_000;
  }

  linksChanged(): void {
    const connecting = [...this.links.values()].filter((link) => !link.connected).map((link) => link.author).sort();
    if (!sameList(connecting, voiceState.value.connecting)) update({ connecting });
  }

  awaitGesture(): void {
    if (this.gestureWaiting || this.ended) return;
    this.gestureWaiting = true;
    addEventListener("pointerdown", this.onGesture, true);
  }

  async signal(link: PeerLink, data: ChatVoiceSignal): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.ended || link.closed || this.links.get(link.session) !== link) return;
      const result = await voicePost({ type: "signal", session: this.session, to: link.session, data });
      if (result.ok) return;
      const code = result.body.code;
      if (code === "CHAT_VOICE_PEER_NOT_FOUND") {
        this.drop(link.session);
        return;
      }
      if (code === "CHAT_VOICE_NOT_FOUND") {
        void this.rejoin(false);
        return;
      }
      if (result.status && result.status < 500 && result.status !== 429) return;
      await wait(500 * 2 ** attempt);
    }
  }

  private readonly onPageHide = () => {
    if (this.ended) return;
    if (this.session && navigator.sendBeacon) {
      navigator.sendBeacon(appPath("/api/chat/voice"), new Blob([JSON.stringify({ type: "leave", session: this.session })], { type: "application/json" }));
    }
    this.finish(null);
  };

  private readonly onOnline = () => {
    if (this.ended) return;
    for (const link of this.links.values()) link.kick();
    if (!this.events) void this.rejoin(false);
  };

  private readonly onGesture = () => {
    this.gestureWaiting = false;
    removeEventListener("pointerdown", this.onGesture, true);
    void this.context?.resume().catch(() => {});
    for (const link of this.links.values()) link.replay();
  };

  private readonly onDeviceChange = () => void this.checkDevice();

  private readonly onTrackEnded = () => void this.reacquire();

  private useMic(stream: MediaStream | null): void {
    const previous = this.mic;
    const previousTrack = this.track;
    this.mic = stream;
    this.track = stream?.getAudioTracks()[0] ?? null;
    if (this.track) {
      const { muted, deafened } = voiceState.value;
      this.track.contentHint = "speech";
      this.track.enabled = !muted && !deafened;
      this.track.addEventListener("ended", this.onTrackEnded);
    }
    for (const link of this.links.values()) void link.sender?.replaceTrack(this.track).catch(() => {});
    previousTrack?.removeEventListener("ended", this.onTrackEnded);
    if (previous !== stream) for (const track of previous?.getTracks() ?? []) track.stop();
    this.source?.disconnect();
    this.source = null;
    if (this.mic && this.context && this.analyser) {
      try {
        this.source = this.context.createMediaStreamSource(this.mic);
        this.source.connect(this.analyser);
      } catch {
        this.source = null;
      }
    }
    update({ micMissing: !this.track, ...(this.track && { error: null }) });
  }

  private async checkDevice(): Promise<void> {
    const track = this.track;
    if (this.ended || !track || !navigator.mediaDevices?.enumerateDevices) return;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    if (this.ended || track !== this.track) return;
    const settings = track.getSettings();
    const fallback = inputs.find((device) => device.deviceId === "default");
    const gone = !!settings.deviceId && !inputs.some((device) => device.deviceId === settings.deviceId);
    const moved = !!fallback && settings.deviceId === "default" && !!settings.groupId && fallback.groupId !== settings.groupId;
    if (track.readyState === "ended" || gone || moved) await this.reacquire();
  }

  private async reacquire(): Promise<void> {
    if (this.ended) return;
    const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: MIC }).catch(() => null);
    if (this.ended) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      return;
    }
    if (stream || this.track?.readyState === "ended") this.useMic(stream ?? null);
  }

  private open(): void {
    this.events?.close();
    const source = new EventSource(appPath(`/api/chat/stream?voice=${encodeURIComponent(this.session)}`));
    this.events = source;
    const read = (event: Event): Record<string, unknown> | null => {
      if (this.events !== source || this.ended) return null;
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    source.addEventListener("voice-session", (event) => {
      const data = read(event);
      const self = data?.self as ChatVoicePeer | undefined;
      if (!data || !self || !Array.isArray(data.peers)) return;
      this.seq = self.seq;
      this.author = self.author;
      const peers = data.peers as ChatVoicePeer[];
      const present = new Set(peers.map((peer) => peer.session));
      for (const session of [...this.links.keys()]) if (!present.has(session)) this.drop(session);
      for (const peer of peers) this.addPeer(peer);
      this.rejoins = 0;
      this.publishPeers();
      update({ phase: "connected" });
      if (this.serverRtt === null) void this.ping();
    });
    source.addEventListener("voice-peer", (event) => {
      const data = read(event);
      if (!data) return;
      if (data.action === "leave" && typeof data.session === "string") {
        this.drop(data.session);
        return;
      }
      const peer = data.peer as ChatVoicePeer | undefined;
      if (!peer || peer.session === this.session) return;
      this.addPeer(peer);
      this.publishPeers();
    });
    source.addEventListener("voice-signal", (event) => {
      const data = read(event);
      const signal = readVoiceSignal(data?.data);
      if (!data || !signal || typeof data.from !== "string") return;
      let link = this.links.get(data.from);
      if (!link && signal.kind === "offer" && typeof data.author === "string") {
        link = new PeerLink(this, data.from, data.author, false);
        this.links.set(data.from, link);
        this.linksChanged();
      }
      link?.receive(signal);
    });
    source.addEventListener("voice-end", (event) => {
      const data = read(event);
      if (!data) return;
      if (data.code === "CHAT_VOICE_EXPIRED") void this.rejoin(true);
      else this.finish(failureText(data.code));
    });
    source.onerror = () => {
      if (this.events !== source || this.ended) return;
      if (source.readyState !== EventSource.CLOSED) {
        update({ phase: "reconnecting" });
        return;
      }
      source.close();
      this.events = null;
      update({ phase: "reconnecting" });
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.rejoin(true);
      }, REJOIN_DELAY_MS);
    };
  }

  private async rejoin(counted: boolean): Promise<void> {
    if (this.ended || this.retryTimer || this.rejoining) return;
    if (counted && this.rejoins >= REJOIN_LIMIT) {
      this.finish(failureText(undefined));
      return;
    }
    if (counted) this.rejoins += 1;
    update({ phase: "reconnecting" });
    this.events?.close();
    this.events = null;
    for (const session of [...this.links.keys()]) this.drop(session);
    const { muted, deafened } = voiceState.value;
    this.rejoining = true;
    const joined = await voicePost({ type: "join", channel: this.channel, muted, deafened });
    this.rejoining = false;
    const voice = joined.body.voice as { session?: unknown } | undefined;
    const session = joined.ok && isVoiceSession(voice?.session) ? voice.session : null;
    if (this.ended) {
      if (session) void voicePost({ type: "leave", session }, true);
      return;
    }
    if (session) {
      this.session = session;
      if (muted !== voiceState.value.muted || deafened !== voiceState.value.deafened) this.applyPreferences();
      this.open();
      return;
    }
    if (joined.status === 0 || joined.status >= 500 || joined.status === 429) {
      if (joined.status === 0 && counted) this.rejoins -= 1;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.rejoin(joined.status !== 0);
      }, joined.status === 0 ? OFFLINE_RETRY_MS : 2_000 * this.rejoins);
      return;
    }
    this.finish(failureText(joined.body.code));
  }

  private addPeer(peer: ChatVoicePeer): void {
    this.peers.set(peer.session, peer);
    const link = this.links.get(peer.session);
    if (link) {
      link.author = peer.author;
      link.applyOutput();
      return;
    }
    this.links.set(peer.session, new PeerLink(this, peer.session, peer.author, peer.seq > this.seq));
    this.linksChanged();
  }

  private drop(session: string): void {
    const link = this.links.get(session);
    link?.close();
    this.links.delete(session);
    if (link) this.heard.delete(link.author);
    if (this.peers.delete(session) || link) {
      this.publishPeers();
      this.linksChanged();
    }
  }

  private publishPeers(): void {
    update({ peers: [...this.peers.values()].sort((left, right) => left.seq - right.seq) });
  }

  private async ping(): Promise<void> {
    if (this.ended || !this.session) return;
    const started = performance.now();
    const result = await voicePost({ type: "ping", session: this.session });
    if (this.ended) return;
    if (result.ok) {
      this.serverRtt = performance.now() - started;
      if (!this.links.size) this.summarize();
    } else if (result.body.code === "CHAT_VOICE_NOT_FOUND") void this.rejoin(true);
  }

  private async sampleAll(): Promise<void> {
    const cap = this.bitrateCap();
    await Promise.all([...this.links.values()].map((link) => link.sample(cap).catch(() => {})));
    if (!this.ended) this.summarize();
  }

  private summarize(): void {
    const rtts = [...this.links.values()]
      .map((link) => link.rtt)
      .filter((rtt): rtt is number => rtt !== null)
      .map((rtt) => rtt * 1_000)
      .sort((left, right) => left - right);
    const ping = rtts.length ? rtts[Math.floor(rtts.length / 2)]! : this.serverRtt;
    const loss = Math.max(0, ...[...this.links.values()].map((link) => link.loss));
    const quality: VoiceQuality | null =
      ping === null ? null : ping < 150 && loss < 0.02 ? "good" : ping < 350 && loss < 0.08 ? "fair" : "poor";
    const rounded = ping === null ? null : Math.round(ping);
    const state = voiceState.value;
    if (state.quality !== quality || state.ping !== rounded) update({ quality, ping: rounded });
  }

  private pollSpeaking(): void {
    const time = performance.now();
    for (const link of this.links.values()) {
      if (!silencedAuthor(link.author) && link.level() > SPEAKING_LEVEL) this.heard.set(link.author, time);
    }
    if (this.author && this.track?.enabled && this.selfLevel() > SELF_LEVEL) this.heard.set(this.author, time);
    const speaking = new Set<string>();
    for (const [author, at] of this.heard) {
      if (time - at < SPEAKING_HOLD_MS) speaking.add(author);
      else this.heard.delete(author);
    }
    if (!sameSet(speaking, voiceSpeaking.value)) voiceSpeaking.value = speaking;
  }

  private selfLevel(): number {
    if (!this.analyser || !this.source) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const value of this.samples) sum += value * value;
    return Math.sqrt(sum / this.samples.length);
  }

}

export function voiceSupported(): boolean {
  return typeof RTCPeerConnection === "function" && typeof EventSource === "function";
}

export function joinVoice(channel: ChatVoiceChannel): void {
  if (active && !active.ended && active.channel === channel) return;
  if (!voiceSupported()) {
    update({ error: negativeMessage("voice does not work in this browser") });
    return;
  }
  active?.leave();
  const call = new VoiceCall(channel);
  active = call;
  void call.start();
}

export function leaveVoice(): void {
  active?.leave();
}

export function clearVoiceError(): void {
  if (voiceState.value.error) update({ error: null });
}

function setPreferences(muted: boolean, deafened: boolean): void {
  store(PREFERENCES_STORAGE, { muted, deafened });
  update({ muted, deafened });
  active?.applyPreferences();
}

export function toggleVoiceMute(): void {
  const state = voiceState.value;
  if (active && state.micMissing && !state.muted && !state.deafened) {
    void active.retryMic();
    return;
  }
  if (state.deafened) setPreferences(false, false);
  else setPreferences(!state.muted, false);
}

export function toggleVoiceDeafen(): void {
  const state = voiceState.value;
  setPreferences(state.muted, !state.deafened);
}

export function toggleVoiceLocalMute(author: string): void {
  const next = new Set(voiceLocalMutes.value);
  if (!next.delete(author)) next.add(author);
  voiceLocalMutes.value = next;
  store(LOCAL_MUTES_STORAGE, [...next]);
  active?.applyOutput();
}

export function setVoiceBlocked(authors: ReadonlySet<string>): void {
  blocked = authors;
  active?.applyOutput();
}

function watchVoiceSpeaking(): () => void {
  speakingWatchers += 1;
  active?.watchSpeaking();
  return () => {
    speakingWatchers -= 1;
    active?.watchSpeaking();
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => active?.watchSpeaking());
}

export function useVoice(): VoiceSnapshot {
  return useUiSignal(voiceState);
}

export function useVoiceSpeaking(enabled: boolean): ReadonlySet<string> {
  useEffect(() => (enabled ? watchVoiceSpeaking() : undefined), [enabled]);
  return useUiSignal(voiceSpeaking);
}

export function useVoiceLocalMutes(): ReadonlySet<string> {
  return useUiSignal(voiceLocalMutes);
}
