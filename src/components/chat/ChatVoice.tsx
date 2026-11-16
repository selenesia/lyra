import ChatDisplayName from "./ChatDisplayName.tsx";
import { useEffect, useState } from "preact/hooks";
import { profileIntent } from "../../features/chat/chatProfiles.ts";
import {
  CHAT_VOICE_CHANNELS,
  CHAT_VOICE_LIMITS,
  CHAT_VOICE_NAMES,
  displayName,
  type ChatMember,
  type ChatVoicePeer,
} from "../../features/chat/chatProtocol.ts";
import type { ChatVoices } from "../../features/chat/chatRoom.ts";
import {
  clearVoiceError,
  joinVoice,
  leaveVoice,
  toggleVoiceDeafen,
  toggleVoiceLocalMute,
  toggleVoiceMute,
  useVoice,
  useVoiceLocalMutes,
  useVoiceSpeaking,
  type VoiceSnapshot,
} from "../../features/chat/chatVoice.ts";
import {
  IconHeadphones,
  IconHeadphonesSlash,
  IconMicrophone,
  IconMicrophoneSlash,
  IconPhoneHangUp,
  IconSignal,
  IconVolumeHalf,
  IconVolumeOff,
} from "../icons";
import ChatAvatar from "./ChatAvatar.tsx";

const ERROR_MS = 5_000;
const QUALITY_LABELS = { good: "good connection", fair: "unsteady connection", poor: "weak connection" } as const;

interface VoiceChannelsProps {
  voices: ChatVoices;
  viewerAuthor: string;
  blocked: ReadonlySet<string>;
  visible: boolean;
  onOpenProfile: (member: ChatMember) => void;
}

interface VoiceMemberProps {
  peer: ChatVoicePeer;
  self: boolean;
  speaking: boolean;
  connecting: boolean;
  heard: boolean;
  locallyMuted: boolean;
  blocked: boolean;
  onOpenProfile: (member: ChatMember) => void;
}

function VoiceMember({ peer, self, speaking, connecting, heard, locallyMuted, blocked, onOpenProfile }: VoiceMemberProps) {
  const name = displayName(peer);
  const silenced = locallyMuted || blocked;
  return (
    <li
      class={`chat-voice-member${speaking ? " speaking" : ""}${connecting ? " connecting" : ""}${blocked ? " blocked" : ""}`}
    >
      <button type="button" class="chat-voice-member-open" {...profileIntent(peer.author)} onClick={() => onOpenProfile(peer)}>
        <span class="chat-voice-face">
          <ChatAvatar member={peer} size={22} />
        </span>
        <span class="chat-voice-member-name"><ChatDisplayName member={peer} /></span>
        {peer.muted && (
          <span class="chat-voice-state" aria-label="muted" data-tooltip="muted">
            <IconMicrophoneSlash size={14} />
          </span>
        )}
        {peer.deafened && (
          <span class="chat-voice-state" aria-label="deafened" data-tooltip="deafened">
            <IconHeadphonesSlash size={14} />
          </span>
        )}
      </button>
      {heard && !self && !blocked && (
        <button
          type="button"
          class={`chat-tool chat-voice-local${locallyMuted ? " is-on" : ""}`}
          aria-pressed={locallyMuted}
          aria-label={locallyMuted ? `unmute ${name} for you` : `mute ${name} for you`}
          data-tooltip={locallyMuted ? "unmute for you" : "mute for you"}
          onClick={() => toggleVoiceLocalMute(peer.author)}
        >
          {silenced ? <IconVolumeOff size={14} /> : <IconVolumeHalf size={14} />}
        </button>
      )}
    </li>
  );
}

function channelTooltip(name: string, here: boolean, count: number): string {
  if (here) return "you are in this voice channel";
  if (count >= CHAT_VOICE_LIMITS.members) return "this voice channel is full";
  return `join ${name}`;
}

function VoiceDuration({ startedAt, visible }: { startedAt: number; visible: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (document.hidden) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1_000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [visible, startedAt]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds / 60) % 60;
  const duration = `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return <span class="chat-voice-count" role="timer" aria-label={`call duration ${duration}`}>{duration}</span>;
}

export function ChatVoiceChannels({ voices, viewerAuthor, blocked, visible, onOpenProfile }: VoiceChannelsProps) {
  const voice = useVoice();
  const speaking = useVoiceSpeaking(visible && !!voice.channel);
  const localMutes = useVoiceLocalMutes();
  const connecting = new Set(voice.connecting);
  return (
    <>
      {CHAT_VOICE_CHANNELS.map((channel) => {
        const name = CHAT_VOICE_NAMES[channel];
        const room = voices[channel];
        const members = room?.members ?? [];
        const here = voice.channel === channel;
        const full = !here && members.length >= CHAT_VOICE_LIMITS.members;
        return (
          <div key={channel} class={`chat-voice-channel${here ? " here" : ""}`}>
            <button
              type="button"
              class={`chat-channel${here ? " active" : ""}`}
              aria-label={here ? `${name}, connected` : `join voice channel ${name}`}
              data-tooltip={channelTooltip(name, here, members.length)}
              aria-disabled={full || undefined}
              onClick={() => {
                if (!here && !full) joinVoice(channel);
              }}
            >
              <IconVolumeHalf size={16} class="chat-channel-icon" />
              <span class="chat-voice-heading">
                <span class="chat-channel-name">{name}</span>
                {members.length > 0 && room?.startedAt != null && (
                  <VoiceDuration startedAt={room.startedAt} visible={visible} />
                )}
              </span>
              {members.length > 0 && (
                <span class="chat-voice-count">
                  {members.length}/{CHAT_VOICE_LIMITS.members}
                </span>
              )}
            </button>
            {members.length > 0 && (
              <ul class="chat-voice-members" aria-label={`people in ${name}`}>
                {members.map((peer) => (
                  <VoiceMember
                    key={peer.session}
                    peer={peer}
                    self={peer.author === viewerAuthor}
                    speaking={here && speaking.has(peer.author)}
                    connecting={here && voice.phase === "connected" && connecting.has(peer.author)}
                    heard={here}
                    locallyMuted={localMutes.has(peer.author)}
                    blocked={blocked.has(peer.author)}
                    onOpenProfile={onOpenProfile}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}

function statusText(voice: VoiceSnapshot): string {
  if (voice.phase === "joining") return "connecting...";
  if (voice.phase === "reconnecting") return "reconnecting...";
  if (voice.peers.length && voice.connecting.length >= voice.peers.length) return "connecting...";
  return "voice connected";
}

export function ChatVoicePanel({ voice }: { voice: VoiceSnapshot }) {
  useEffect(() => {
    if (!voice.error) return;
    const timer = setTimeout(clearVoiceError, ERROR_MS);
    return () => clearTimeout(timer);
  }, [voice.error]);
  const error = voice.error ? <p class="chat-status is-error chat-voice-error" role="status">{voice.error}</p> : null;
  if (!voice.channel) return error;
  const live = voice.phase === "connected" && statusText(voice) === "voice connected";
  const quality = live ? voice.quality : null;
  const detail = quality && voice.ping !== null ? `${QUALITY_LABELS[quality]}, ${voice.ping} ms` : undefined;
  return (
    <>
      {error}
      <div class="chat-voice-panel" data-quality={quality ?? "none"}>
        <div class="chat-voice-status" aria-live="polite">
          <span class="chat-voice-signal" data-tooltip={detail} aria-label={detail}>
            <IconSignal size={16} />
          </span>
          <span class="chat-voice-status-text">
            <span class="chat-voice-status-label">{statusText(voice)}</span>
            <span class="chat-voice-status-channel">
              {CHAT_VOICE_NAMES[voice.channel]}
              {live && voice.ping !== null && <span class="chat-voice-ping"> · {voice.ping} ms</span>}
            </span>
          </span>
        </div>
        <button type="button" class="chat-tool danger" aria-label="disconnect" data-tooltip="disconnect" onClick={leaveVoice}>
          <IconPhoneHangUp size={18} />
        </button>
      </div>
    </>
  );
}

export function ChatVoiceControls({ voice }: { voice: VoiceSnapshot }) {
  const muted = voice.muted || voice.deafened;
  const micOff = muted || voice.micMissing;
  const micLabel = muted ? "unmute" : voice.micMissing ? "allow microphone" : "mute";
  const deafenLabel = voice.deafened ? "undeafen" : "deafen";
  return (
    <div class="chat-voice-controls">
      <button
        type="button"
        class={`chat-tool${micOff ? " danger" : ""}`}
        aria-pressed={micOff}
        aria-label={micLabel}
        data-tooltip={micLabel}
        onClick={toggleVoiceMute}
      >
        {micOff ? <IconMicrophoneSlash size={18} /> : <IconMicrophone size={18} />}
      </button>
      <button
        type="button"
        class={`chat-tool${voice.deafened ? " danger" : ""}`}
        aria-pressed={voice.deafened}
        aria-label={deafenLabel}
        data-tooltip={deafenLabel}
        onClick={toggleVoiceDeafen}
      >
        {voice.deafened ? <IconHeadphonesSlash size={18} /> : <IconHeadphones size={18} />}
      </button>
    </div>
  );
}
