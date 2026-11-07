import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  bytesContainSensitiveText,
  isCredentialObject,
  isSensitiveSyncName,
  isSensitiveSyncText,
} from "./syncPolicy.ts";

export type EncodedValue =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
  | { type: "number"; value: number | "nan" | "infinity" | "-infinity" | "-0" }
  | { type: "bigint"; value: string }
  | { type: "reference"; value: number }
  | { type: "date"; id: number; value: string }
  | { type: "regexp"; id: number; value: { source: string; flags: string } }
  | { type: "array"; id: number; value: EncodedValue[] }
  | { type: "object"; id: number; value: Record<string, EncodedValue> }
  | { type: "map"; id: number; value: Array<[EncodedValue, EncodedValue]> }
  | { type: "set"; id: number; value: EncodedValue[] }
  | { type: "array_buffer"; id: number; value: string }
  | {
      type: "typed_array";
      id: number;
      value: {
        name: string;
        buffer: EncodedValue;
        byteOffset: number;
        length: number;
      };
    }
  | { type: "blob"; id: number; value: { mediaType: string; bytes: string } }
  | {
      type: "file";
      id: number;
      value: {
        name: string;
        mediaType: string;
        lastModified: number;
        bytes: string;
      };
    };

interface EncodeState {
  ids: WeakMap<object, number>;
  nextId: number;
}

const TYPED_ARRAY_NAMES = new Set([
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

export function syncError(message: string): Error {
  return new Error(negativeMessage(message));
}

function validEncodedBytes(value: string): boolean {
  const chunkSize = 64 * 1024;
  const overlap = 512;
  if (
    value.length % 4 !== 0 ||
    (value.indexOf("=") >= 0 && value.indexOf("=") < value.length - 2)
  ) {
    return false;
  }
  let carry = new Uint8Array();
  try {
    for (let offset = 0; offset < value.length; offset += chunkSize) {
      const bytes = base64ToBytes(value.slice(offset, offset + chunkSize));
      const scanned = new Uint8Array(carry.length + bytes.length);
      scanned.set(carry);
      scanned.set(bytes, carry.length);
      if (bytesContainSensitiveText(scanned)) return false;
      carry = scanned.slice(Math.max(0, scanned.length - overlap));
    }
    return true;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(value);
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function typedArray(
  name: string,
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
): ArrayBufferView {
  switch (name) {
    case "DataView":
      return new DataView(buffer, byteOffset, length);
    case "Int8Array":
      return new Int8Array(buffer, byteOffset, length);
    case "Uint8Array":
      return new Uint8Array(buffer, byteOffset, length);
    case "Uint8ClampedArray":
      return new Uint8ClampedArray(buffer, byteOffset, length);
    case "Int16Array":
      return new Int16Array(buffer, byteOffset, length);
    case "Uint16Array":
      return new Uint16Array(buffer, byteOffset, length);
    case "Int32Array":
      return new Int32Array(buffer, byteOffset, length);
    case "Uint32Array":
      return new Uint32Array(buffer, byteOffset, length);
    case "Float32Array":
      return new Float32Array(buffer, byteOffset, length);
    case "Float64Array":
      return new Float64Array(buffer, byteOffset, length);
    case "BigInt64Array":
      return new BigInt64Array(buffer, byteOffset, length);
    case "BigUint64Array":
      return new BigUint64Array(buffer, byteOffset, length);
    default:
      throw syncError("unsupported typed array");
  }
}

async function encodeValue(
  value: unknown,
  state: EncodeState,
  allowSensitive = false,
): Promise<EncodedValue> {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "bigint")
    return { type: "bigint", value: String(value) };
  if (typeof value === "number") {
    const encoded = Number.isNaN(value)
      ? "nan"
      : value === Number.POSITIVE_INFINITY
        ? "infinity"
        : value === Number.NEGATIVE_INFINITY
          ? "-infinity"
          : Object.is(value, -0)
            ? "-0"
            : value;
    return { type: "number", value: encoded };
  }
  if (typeof value !== "object") {
    throw syncError("unsupported browser storage value");
  }
  if (isCredentialObject(value)) {
    throw syncError("credential values cannot be synced");
  }

  const existingId = state.ids.get(value);
  if (existingId !== undefined) return { type: "reference", value: existingId };
  const id = state.nextId++;
  state.ids.set(value, id);

  if (value instanceof Date) {
    return { type: "date", id, value: value.toISOString() };
  }
  if (value instanceof RegExp) {
    return {
      type: "regexp",
      id,
      value: { source: value.source, flags: value.flags },
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      type: "array_buffer",
      id,
      value: bytesToBase64(new Uint8Array(value)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const name =
      value instanceof DataView ? "DataView" : value.constructor.name;
    const length = "length" in value ? Number(value.length) : value.byteLength;
    return {
      type: "typed_array",
      id,
      value: {
        name,
        buffer: await encodeValue(value.buffer, state, allowSensitive),
        byteOffset: value.byteOffset,
        length,
      },
    };
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return {
      type: "file",
      id,
      value: {
        name: value.name,
        mediaType: value.type,
        lastModified: value.lastModified,
        bytes: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      },
    };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return {
      type: "blob",
      id,
      value: {
        mediaType: value.type,
        bytes: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      },
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      id,
      value: await Promise.all(
        value.map((entry) => encodeValue(entry, state, allowSensitive)),
      ),
    };
  }
  if (value instanceof Map) {
    const entries: Array<[EncodedValue, EncodedValue]> = [];
    for (const [key, entry] of value) {
      if (
        !allowSensitive &&
        typeof key === "string" &&
        isSensitiveSyncName(key)
      ) {
        continue;
      }
      entries.push([
        await encodeValue(key, state, allowSensitive),
        await encodeValue(entry, state, allowSensitive),
      ]);
    }
    return { type: "map", id, value: entries };
  }
  if (value instanceof Set) {
    const entries: EncodedValue[] = [];
    for (const entry of value) {
      entries.push(await encodeValue(entry, state, allowSensitive));
    }
    return { type: "set", id, value: entries };
  }

  const entries: Record<string, EncodedValue> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (!allowSensitive && isSensitiveSyncName(key)) continue;
    entries[key] = await encodeValue(
      (value as Record<string, unknown>)[key],
      state,
      allowSensitive,
    );
  }
  return { type: "object", id, value: entries };
}

export function encodeBrowserValue(
  value: unknown,
  allowSensitive = false,
): Promise<EncodedValue> {
  return encodeValue(value, { ids: new WeakMap(), nextId: 1 }, allowSensitive);
}

function decodeValue(
  encoded: EncodedValue,
  references: Map<number, unknown>,
): unknown {
  switch (encoded.type) {
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "boolean":
    case "string":
      return encoded.value;
    case "number":
      if (typeof encoded.value === "number") return encoded.value;
      if (encoded.value === "nan") return Number.NaN;
      if (encoded.value === "infinity") return Number.POSITIVE_INFINITY;
      if (encoded.value === "-infinity") return Number.NEGATIVE_INFINITY;
      return -0;
    case "bigint":
      return BigInt(encoded.value);
    case "reference": {
      if (!references.has(encoded.value)) {
        throw syncError("invalid browser storage reference");
      }
      return references.get(encoded.value);
    }
    case "date": {
      const value = new Date(encoded.value);
      references.set(encoded.id, value);
      return value;
    }
    case "regexp": {
      const value = new RegExp(encoded.value.source, encoded.value.flags);
      references.set(encoded.id, value);
      return value;
    }
    case "array": {
      const value: unknown[] = [];
      references.set(encoded.id, value);
      for (const entry of encoded.value) {
        value.push(decodeValue(entry, references));
      }
      return value;
    }
    case "object": {
      const value: Record<string, unknown> = {};
      references.set(encoded.id, value);
      for (const [key, entry] of Object.entries(encoded.value)) {
        Object.defineProperty(value, key, {
          value: decodeValue(entry, references),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return value;
    }
    case "map": {
      const value = new Map<unknown, unknown>();
      references.set(encoded.id, value);
      for (const [key, entry] of encoded.value) {
        value.set(decodeValue(key, references), decodeValue(entry, references));
      }
      return value;
    }
    case "set": {
      const value = new Set<unknown>();
      references.set(encoded.id, value);
      for (const entry of encoded.value) {
        value.add(decodeValue(entry, references));
      }
      return value;
    }
    case "array_buffer": {
      const bytes = base64ToBytes(encoded.value);
      const value = bytesToArrayBuffer(bytes);
      references.set(encoded.id, value);
      return value;
    }
    case "typed_array": {
      const buffer = decodeValue(
        encoded.value.buffer,
        references,
      ) as ArrayBuffer;
      const value = typedArray(
        encoded.value.name,
        buffer,
        encoded.value.byteOffset,
        encoded.value.length,
      );
      references.set(encoded.id, value);
      return value;
    }
    case "blob": {
      const value = new Blob(
        [bytesToArrayBuffer(base64ToBytes(encoded.value.bytes))],
        {
          type: encoded.value.mediaType,
        },
      );
      references.set(encoded.id, value);
      return value;
    }
    case "file": {
      const bytes = base64ToBytes(encoded.value.bytes);
      const value =
        typeof File === "undefined"
          ? new Blob([bytesToArrayBuffer(bytes)], {
              type: encoded.value.mediaType,
            })
          : new File([bytesToArrayBuffer(bytes)], encoded.value.name, {
              type: encoded.value.mediaType,
              lastModified: encoded.value.lastModified,
            });
      references.set(encoded.id, value);
      return value;
    }
  }
}

export function decodeBrowserValue(encoded: EncodedValue): unknown {
  return decodeValue(encoded, new Map());
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validEncodedValue(
  value: unknown,
  ids = new Set<number>(),
  allowSensitive = false,
): value is EncodedValue {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "null" || value.type === "undefined") return true;
  if (value.type === "boolean") return typeof value.value === "boolean";
  if (value.type === "string") {
    return (
      typeof value.value === "string" &&
      (allowSensitive || !isSensitiveSyncText(value.value))
    );
  }
  if (value.type === "bigint") {
    return typeof value.value === "string";
  }
  if (value.type === "number") {
    return (
      typeof value.value === "number" ||
      ["nan", "infinity", "-infinity", "-0"].includes(String(value.value))
    );
  }
  if (value.type === "reference") {
    return typeof value.value === "number" && ids.has(value.value);
  }
  if (typeof value.id !== "number" || ids.has(value.id)) return false;
  ids.add(value.id);
  if (value.type === "date") {
    return typeof value.value === "string";
  }
  if (value.type === "array_buffer") {
    return (
      typeof value.value === "string" &&
      (allowSensitive || validEncodedBytes(value.value))
    );
  }
  if (value.type === "regexp") {
    return (
      isRecord(value.value) &&
      typeof value.value.source === "string" &&
      typeof value.value.flags === "string"
    );
  }
  if (value.type === "array" || value.type === "set") {
    return (
      Array.isArray(value.value) &&
      value.value.every((entry) =>
        validEncodedValue(entry, ids, allowSensitive),
      )
    );
  }
  if (value.type === "object") {
    return (
      isRecord(value.value) &&
      Object.entries(value.value).every(
        ([key, entry]) =>
          (allowSensitive || !isSensitiveSyncName(key)) &&
          validEncodedValue(entry, ids, allowSensitive),
      )
    );
  }
  if (value.type === "map") {
    return (
      Array.isArray(value.value) &&
      value.value.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          (allowSensitive ||
            !(
              isRecord(entry[0]) &&
              entry[0].type === "string" &&
              typeof entry[0].value === "string" &&
              isSensitiveSyncName(entry[0].value)
            )) &&
          validEncodedValue(entry[0], ids, allowSensitive) &&
          validEncodedValue(entry[1], ids, allowSensitive),
      )
    );
  }
  if (value.type === "typed_array") {
    return (
      isRecord(value.value) &&
      typeof value.value.name === "string" &&
      TYPED_ARRAY_NAMES.has(value.value.name) &&
      typeof value.value.byteOffset === "number" &&
      typeof value.value.length === "number" &&
      validEncodedValue(value.value.buffer, ids, allowSensitive)
    );
  }
  if (value.type === "blob") {
    return (
      isRecord(value.value) &&
      typeof value.value.mediaType === "string" &&
      typeof value.value.bytes === "string" &&
      (allowSensitive || validEncodedBytes(value.value.bytes))
    );
  }
  if (value.type === "file") {
    return (
      isRecord(value.value) &&
      typeof value.value.name === "string" &&
      typeof value.value.mediaType === "string" &&
      typeof value.value.lastModified === "number" &&
      typeof value.value.bytes === "string" &&
      (allowSensitive || validEncodedBytes(value.value.bytes))
    );
  }
  return false;
}
