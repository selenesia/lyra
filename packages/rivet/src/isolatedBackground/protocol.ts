import type { ExtensionMessage, BackgroundInfo } from "../manifest";
import type { ChromeManifest } from "../types";

export const ISOLATED_BACKGROUND_HELLO = "rivet.isolatedBackground.hello";
export const ISOLATED_BACKGROUND_INIT = "rivet.isolatedBackground.init";
const FUNCTION_MARKER = "rivet.isolatedBackground.function";

export type ApiShape =
  | { kind: "function" }
  | { kind: "event" }
  | { kind: "lastError" }
  | { kind: "value"; value: unknown }
  | { kind: "alias"; path: string[] }
  | { kind: "namespace"; members: Record<string, ApiShape> };

export type IsolatedListenerKind =
  "event" | "message" | "connect" | "webRequest";

export interface IsolatedBackgroundInit {
  type: typeof ISOLATED_BACKGROUND_INIT;
  extId: string;
  manifest: ChromeManifest;
  messages: Record<string, ExtensionMessage>;
  shape: ApiShape;
  background: NonNullable<BackgroundInfo>;
  senderUrl: string | undefined;
  responseTimeoutMs: number | undefined;
}

export interface EncodedFunction {
  [FUNCTION_MARKER]: number;
  source: string;
}

export type FrameToHostMessage =
  | {
      type: "call";
      id: number;
      path: string[];
      args: unknown[];
      functions: boolean;
    }
  | {
      type: "listen";
      listener: number;
      path: string[];
      kind: IsolatedListenerKind;
      options: unknown[];
    }
  | { type: "unlisten"; listener: number }
  | { type: "reply"; id: number; value: unknown }
  | { type: "connect"; port: string; args: unknown[] }
  | { type: "portPost"; port: string; message: unknown }
  | { type: "portDisconnect"; port: string }
  | { type: "storageListening"; id: number }
  | { type: "storageChanged"; area: string; changes: unknown }
  | { type: "ready" }
  | { type: "failed" };

export type HostToFrameMessage =
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; message: string }
  | { type: "event"; listener: number; args: unknown[] }
  | { type: "request"; id: number; listener: number; args: unknown[] }
  | { type: "invoke"; fn: number; args: unknown[] }
  | { type: "release"; fn: number; count: number }
  | {
      type: "portOpen";
      listener: number;
      port: string;
      name: string;
      sender: unknown;
    }
  | { type: "portMessage"; port: string; message: unknown }
  | { type: "portDisconnect"; port: string }
  | { type: "responseTimeout"; value: number | undefined };

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function isEncodedFunction(value: unknown): value is EncodedFunction {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[FUNCTION_MARKER] === "number"
  );
}

export function encodedFunctionId(value: EncodedFunction): number {
  return value[FUNCTION_MARKER];
}

export function encodeFunction(id: number, source: string): EncodedFunction {
  return { [FUNCTION_MARKER]: id, source };
}

export function mapFunctions(
  value: unknown,
  replace: (fn: (...args: unknown[]) => unknown) => unknown,
): { value: unknown; replaced: boolean } {
  let replaced = false;
  const seen = new Map<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === "function") {
      replaced = true;
      return replace(current as (...args: unknown[]) => unknown);
    }
    if (typeof current !== "object" || current === null) return current;
    const known = seen.get(current);
    if (known !== undefined) return known;
    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      seen.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }
    if (!isPlainRecord(current)) return current;
    const copy: Record<string, unknown> = {};
    seen.set(current, copy);
    for (const [key, item] of Object.entries(current)) copy[key] = visit(item);
    return copy;
  };
  const mapped = visit(value);
  return { value: mapped, replaced };
}

export function restoreFunctions(
  value: unknown,
  restore: (encoded: EncodedFunction) => unknown,
): unknown {
  const seen = new Set<object>();
  const visit = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) return current;
    if (isEncodedFunction(current)) return restore(current);
    if (seen.has(current)) return current;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1)
        current[index] = visit(current[index]);
      return current;
    }
    if (!isPlainRecord(current)) return current;
    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = visit(record[key]);
    return current;
  };
  return visit(value);
}
