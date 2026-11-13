import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cropBoxes } from "./chat-image-frames.mjs";
import { VIDEO_COVERAGE } from "./chat-image-policy.mjs";
import { CHAT_AUDIO, CHAT_VIDEO } from "../src/features/chat/chatProtocol.ts";
import { NEGATIVE } from "../src/core/runtime/messages.ts";

const PRIORITY = 10;
const VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp8", "vp9"]);
const WEBM_VIDEO = new Set(["vp8", "vp9"]);
const AUDIO_OUTPUTS = {
  mp3: { type: "audio/mpeg", format: "mp3" },
  aac: { type: "audio/mp4", format: "mp4" },
  alac: { type: "audio/mp4", format: "mp4" },
  opus: { type: "audio/webm", format: "webm" },
  vorbis: { type: "audio/webm", format: "webm" },
  flac: { type: "audio/flac", format: "flac" },
  pcm_u8: { type: "audio/wav", format: "wav" },
  pcm_s16le: { type: "audio/wav", format: "wav" },
  pcm_s24le: { type: "audio/wav", format: "wav" },
  pcm_s32le: { type: "audio/wav", format: "wav" },
  pcm_f32le: { type: "audio/wav", format: "wav" },
};
const OUTPUT_DEMUXERS = { mp4: "mov", webm: "matroska", mp3: "mp3", flac: "flac", wav: "wav" };

const ascii = (bytes, start, text) =>
  bytes.length >= start + text.length && Buffer.from(bytes.buffer, bytes.byteOffset + start, text.length).toString("latin1") === text;

export function chatAudioVideoDemuxer(bytes) {
  if (ascii(bytes, 4, "ftyp")) return "mov";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "matroska";
  if (ascii(bytes, 0, "OggS")) return "ogg";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "wav";
  if (ascii(bytes, 0, "fLaC")) return "flac";
  if (ascii(bytes, 0, "ID3")) return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "aac";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return "mp3";
  return null;
}

function videoPlan(video, audio) {
  const webm = WEBM_VIDEO.has(video.codec_name);
  const copyAudio = audio && (webm ? ["opus", "vorbis"] : ["aac", "mp3"]).includes(audio.codec_name);
  const audioArgs = !audio ? [] : copyAudio ? ["-c:a", "copy"] : webm ? ["-c:a", "libopus", "-b:a", "128k"] : ["-c:a", "aac", "-b:a", "160k"];
  return {
    type: webm ? "video/webm" : "video/mp4",
    format: webm ? "webm" : "mp4",
    args: [
      "-map", "0:V:0", ...(audio ? ["-map", "0:a:0"] : []),
      "-c:v", "copy", ...(video.codec_name === "hevc" ? ["-tag:v", "hvc1"] : []),
      ...audioArgs,
    ],
  };
}

function audioPlan(audio) {
  const output = AUDIO_OUTPUTS[audio.codec_name] ?? { type: "audio/mp4", format: "mp4", encode: true };
  return {
    type: output.type,
    format: output.format,
    args: ["-map", "0:a:0", "-vn", ...(output.encode ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "copy"])],
  };
}

function rotated(stream) {
  const turn = Math.abs(Number(stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation) || 0) % 180;
  return turn === 90 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
}

export function videoFrameCount(duration, width, height) {
  const perFrame = cropBoxes(width, height).length;
  return Math.max(1, Math.min(Math.ceil(duration / VIDEO_COVERAGE.everySeconds), Math.floor(VIDEO_COVERAGE.crops / perFrame)));
}

export function createChatAudioVideo({
  ffmpeg = Bun.which("ffmpeg"),
  ffprobe = Bun.which("ffprobe"),
  concurrency = 2,
  maxWaiting = 8,
  timeoutMs = 60_000,
} = {}) {
  let running = 0;
  const waiting = [];

  async function slot(task) {
    if (running >= concurrency) {
      if (waiting.length >= maxWaiting) return { unavailable: true };
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  }

  async function run(command, args) {
    const child = Bun.spawn([command, "-hide_banner", "-loglevel", "error", ...args], {
      env: {},
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      os.setPriority(child.pid, PRIORITY);
    } catch {}
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, killed: child.signalCode !== null, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe(file, demuxer) {
    const result = await run(ffprobe, [
      "-protocol_whitelist", "file",
      "-f", demuxer,
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic:stream_side_data=rotation",
      "-of", "json",
      file,
    ]);
    if (result.killed) return { unavailable: true };
    if (result.code !== 0) return { invalid: true };
    try {
      return { info: JSON.parse(result.stdout) };
    } catch {
      return { invalid: true };
    }
  }

  async function prepareIn(dir, bytes, demuxer) {
    const input = path.join(dir, "input");
    await Bun.write(input, bytes);
    const probed = await probe(input, demuxer);
    if (!probed.info) return probed;
    const streams = Array.isArray(probed.info.streams) ? probed.info.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const duration = Number(probed.info.format?.duration);
    if (!(duration > 0) || (!video && !audio)) return { invalid: true };
    const kind = video ? "video" : "audio";
    const limits = video ? CHAT_VIDEO : CHAT_AUDIO;
    if (duration > limits.seconds + 0.5) return { tooLong: true, kind };
    let size = { width: 0, height: 0 };
    if (video) {
      if (!VIDEO_CODECS.has(video.codec_name)) return { unsupported: true, kind };
      size = rotated(video);
      if (!(size.width >= 1 && size.height >= 1 && size.width <= CHAT_VIDEO.side && size.height <= CHAT_VIDEO.side)) return { invalid: true, kind };
    }
    const plan = video ? videoPlan(video, audio) : audioPlan(audio);
    const output = path.join(dir, `output.${plan.format}`);
    const remuxed = await run(ffmpeg, [
      "-nostdin",
      "-threads", "2",
      "-protocol_whitelist", "file",
      "-f", demuxer,
      "-i", input,
      ...plan.args,
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      ...(plan.format === "mp4" ? ["-movflags", "+faststart"] : []),
      "-f", plan.format,
      output,
    ]);
    if (remuxed.killed) return { unavailable: true };
    if (remuxed.code !== 0) return { invalid: true, kind };
    const stored = new Uint8Array(await Bun.file(output).arrayBuffer());
    if (!stored.length) return { invalid: true, kind };
    if (stored.length > limits.bytes) return { tooLarge: true, kind };
    const media = {
      type: plan.type,
      ...size,
      hash: createHash("sha256").update(stored).digest("base64url").slice(0, 16),
      bytes: stored,
    };
    if (!video) return { media, frames: [] };
    const count = videoFrameCount(duration, size.width, size.height);
    const side = VIDEO_COVERAGE.side;
    const sampled = await run(ffmpeg, [
      "-nostdin",
      "-threads", "2",
      "-protocol_whitelist", "file",
      "-f", OUTPUT_DEMUXERS[plan.format],
      "-i", output,
      "-map", "0:V:0",
      "-an",
      "-vf", `fps=${count / duration},scale=w='min(iw,${side})':h='min(ih,${side})':force_original_aspect_ratio=decrease`,
      "-frames:v", String(count),
      "-q:v", "3",
      path.join(dir, "frame-%03d.jpg"),
    ]);
    if (sampled.killed) return { unavailable: true };
    if (sampled.code !== 0) return { invalid: true, kind };
    const names = (await fs.readdir(dir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    if (!names.length) return { invalid: true, kind };
    const frames = [];
    for (const name of names) frames.push({ bytes: new Uint8Array(await Bun.file(path.join(dir, name)).arrayBuffer()), type: "image/jpeg" });
    return { media, frames };
  }

  async function prepare(bytes) {
    const demuxer = chatAudioVideoDemuxer(bytes);
    if (!demuxer) return { unsupported: true };
    if (!ffmpeg || !ffprobe) return { unavailable: true };
    return slot(async () => {
      let dir;
      try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "lyra-chat-media-"));
        return await prepareIn(dir, bytes, demuxer);
      } catch (error) {
        console.error("chat media could not be prepared:", error?.code ?? error?.name, NEGATIVE);
        return { unavailable: true };
      } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  return { prepare, available: () => !!ffmpeg && !!ffprobe };
}
