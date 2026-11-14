import type {
  RawHeaders,
  WebSocketDataType,
} from "@mercuryworkshop/proxy-transports";
import { negativeMessage } from "../runtime/messages.ts";

type EpoxyIoStream = {
  read: ReadableStream<Uint8Array>;
  write: WritableStream<Uint8Array>;
};

export type EpoxyStreamClient = {
  connect_tcp(url: string): Promise<EpoxyIoStream>;
  connect_tls(url: string): Promise<EpoxyIoStream>;
};

type Frame = { fin: boolean; opcode: number; payload: Uint8Array };

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;
const CONTINUATION = 0;
const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[^\r\n\0]*$/;
const RESERVED_HEADERS = new Set([
  "connection",
  "host",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
]);

class WebSocketProtocolError extends Error {
  constructor(readonly code: number) {
    super(negativeMessage("websocket protocol error"));
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (!left.length) return right;
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const lengthBytes = payload.length < 126 ? 0 : payload.length < 65536 ? 2 : 8;
  const offset = 6 + lengthBytes;
  const frame = new Uint8Array(offset + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x80 | opcode;
  if (lengthBytes === 0) frame[1] = 0x80 | payload.length;
  else if (lengthBytes === 2) {
    frame[1] = 0x80 | 126;
    view.setUint16(2, payload.length);
  } else {
    frame[1] = 0x80 | 127;
    view.setBigUint64(2, BigInt(payload.length));
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  frame.set(mask, offset - 4);
  for (let index = 0; index < payload.length; index++) {
    frame[offset + index] = payload[index]! ^ mask[index & 3]!;
  }
  return frame;
}

function decodeFrame(buffer: Uint8Array): { frame: Frame; size: number } | null {
  if (buffer.length < 2) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const first = buffer[0]!;
  const second = buffer[1]!;
  if (first & 0x70 || second & 0x80) throw new WebSocketProtocolError(1002);
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = view.getUint16(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const longLength = view.getBigUint64(2);
    if (longLength > BigInt(MAX_MESSAGE_BYTES)) {
      throw new WebSocketProtocolError(1009);
    }
    length = Number(longLength);
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES) throw new WebSocketProtocolError(1009);
  if (buffer.length < offset + length) return null;
  return {
    frame: {
      fin: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload: buffer.slice(offset, offset + length),
    },
    size: offset + length,
  };
}

function headerEnd(buffer: Uint8Array): number {
  for (let index = 3; index < buffer.length; index++) {
    if (
      buffer[index] === 10 &&
      buffer[index - 1] === 13 &&
      buffer[index - 2] === 10 &&
      buffer[index - 3] === 13
    ) {
      return index + 1;
    }
  }
  return -1;
}

async function acceptFor(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(key + ACCEPT_GUID),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function upgradeRequest(
  url: URL,
  protocols: string[],
  requestHeaders: RawHeaders,
  key: string,
): string {
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (!protocols.every((protocol) => HEADER_NAME.test(protocol))) {
    throw new Error(negativeMessage("websocket protocol is invalid"));
  }
  if (protocols.length) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  let userAgent = false;
  for (const [name, value] of requestHeaders) {
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) {
      throw new Error(negativeMessage("websocket request header is invalid"));
    }
    const lowerName = name.toLowerCase();
    if (RESERVED_HEADERS.has(lowerName) || !value) continue;
    if (lowerName === "user-agent") userAgent = true;
    lines.push(`${name}: ${value}`);
  }
  if (!userAgent) lines.push(`User-Agent: ${navigator.userAgent}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function upgradeHeaders(head: string): Map<string, string> | null {
  const [statusLine, ...lines] = head.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?: |$)/.test(statusLine ?? "")) return null;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return headers;
}

export function connectEpoxyWebSocket(
  client: EpoxyStreamClient,
  url: URL,
  protocols: string[],
  requestHeaders: RawHeaders,
  onopen: (protocol: string, extensions: string) => void,
  onmessage: (data: WebSocketDataType) => void,
  onclose: (code: number, reason: string) => void,
  onerror: (error: string) => void,
): [(data: WebSocketDataType) => void, (code: number, reason: string) => void] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let opened = false;
  let closeSent = false;
  let finished = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    reader?.cancel().catch(() => {});
    writer?.close().catch(() => {});
  };

  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(closeTimer);
    release();
    if (opened) onclose(code, reason);
    else onerror(negativeMessage("websocket connection failed"));
  };

  const opening = (async () => {
    const secure = url.protocol === "wss:";
    const port = url.port || (secure ? "443" : "80");
    const target = `${url.protocol}//${url.hostname}:${port}`;
    const io = await (secure
      ? client.connect_tls(target)
      : client.connect_tcp(target));
    reader = io.read.getReader();
    writer = io.write.getWriter();
    if (finished) {
      release();
      throw new Error(negativeMessage("websocket closed before connecting"));
    }
    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    await writer.write(
      encoder.encode(upgradeRequest(url, protocols, requestHeaders, key)),
    );
    let buffer: Uint8Array = new Uint8Array();
    let end = -1;
    while (end < 0) {
      const { value, done } = await reader.read();
      if (done || finished) throw new Error(negativeMessage("websocket handshake ended early"));
      buffer = concat(buffer, value);
      end = headerEnd(buffer);
      if (end < 0 && buffer.length > MAX_HANDSHAKE_BYTES) {
        throw new Error(negativeMessage("websocket handshake is too large"));
      }
    }
    const headers = upgradeHeaders(new TextDecoder("latin1").decode(buffer.subarray(0, end)));
    const protocol = headers?.get("sec-websocket-protocol") ?? "";
    if (
      !headers ||
      headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !headers
        .get("connection")
        ?.toLowerCase()
        .split(",")
        .some((token) => token.trim() === "upgrade") ||
      headers.get("sec-websocket-accept") !== (await acceptFor(key)) ||
      headers.get("sec-websocket-extensions") ||
      (protocol && !protocols.includes(protocol))
    ) {
      throw new Error(negativeMessage("websocket handshake was rejected"));
    }
    if (finished) throw new Error(negativeMessage("websocket closed before connecting"));
    opened = true;
    onopen(protocol, "");
    return buffer.slice(end);
  })();

  let writing: Promise<unknown> = opening;
  const write = (frame: () => Promise<Uint8Array> | Uint8Array) => {
    writing = writing
      .then(async () => {
        if (finished || !writer) return;
        await writer.write(await frame());
      })
      .catch(() => finish(1006, ""));
  };

  const sendClose = (code: number | undefined, reason: string) => {
    if (closeSent) return;
    closeSent = true;
    let payload = new Uint8Array();
    if (code !== undefined && Number.isInteger(code) && code >= 1000 && code <= 4999) {
      const reasonBytes = encoder.encode(reason).subarray(0, 123);
      payload = new Uint8Array(2 + reasonBytes.length);
      new DataView(payload.buffer).setUint16(0, code);
      payload.set(reasonBytes, 2);
    }
    write(() => encodeFrame(CLOSE, payload));
  };

  let message: Uint8Array = new Uint8Array();
  let messageOpcode = 0;
  const receive = ({ fin, opcode, payload }: Frame): boolean => {
    if (opcode >= CLOSE) {
      if (!fin || payload.length > 125) throw new WebSocketProtocolError(1002);
      if (opcode === CLOSE) {
        const code =
          payload.length >= 2
            ? new DataView(payload.buffer, payload.byteOffset).getUint16(0)
            : 1005;
        const reason = decoder.decode(payload.subarray(2));
        sendClose(payload.length >= 2 ? code : undefined, "");
        void writing.then(() => finish(code, reason));
        return false;
      }
      if (opcode === PING) write(() => encodeFrame(PONG, payload));
      else if (opcode !== PONG) throw new WebSocketProtocolError(1002);
      return true;
    }
    if (opcode === CONTINUATION) {
      if (!messageOpcode) throw new WebSocketProtocolError(1002);
    } else if ((opcode === TEXT || opcode === BINARY) && !messageOpcode) {
      messageOpcode = opcode;
    } else {
      throw new WebSocketProtocolError(1002);
    }
    message = concat(message, payload);
    if (message.length > MAX_MESSAGE_BYTES) throw new WebSocketProtocolError(1009);
    if (fin) {
      const data = messageOpcode === TEXT ? decoder.decode(message) : (message.buffer as ArrayBuffer);
      message = new Uint8Array();
      messageOpcode = 0;
      onmessage(data);
    }
    return true;
  };

  opening
    .then(async (initial) => {
      let buffer: Uint8Array = initial;
      for (;;) {
        for (let decoded = decodeFrame(buffer); decoded; decoded = decodeFrame(buffer)) {
          buffer = buffer.subarray(decoded.size);
          if (!receive(decoded.frame) || finished) return;
        }
        const { value, done } = await reader!.read();
        if (done || finished) return finish(1006, "");
        buffer = concat(buffer, value);
      }
    })
    .catch((error) => {
      if (opened && error instanceof WebSocketProtocolError) {
        sendClose(error.code, "");
        void writing.then(() => finish(1006, ""));
      } else {
        finish(1006, "");
      }
    });

  return [
    (data) => {
      if (closeSent || finished) return;
      write(async () =>
        typeof data === "string"
          ? encodeFrame(TEXT, encoder.encode(data))
          : encodeFrame(
              BINARY,
              new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data),
            ),
      );
    },
    (code, reason) => {
      if (finished) return;
      if (!opened) return finish(1006, "");
      sendClose(code, reason ?? "");
      closeTimer = setTimeout(() => finish(1006, ""), CLOSE_TIMEOUT_MS);
    },
  ];
}
