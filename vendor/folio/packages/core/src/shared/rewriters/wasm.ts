import {
	initSync,
	Rewriter as WasmRewriter,
} from "../../../rewriter/wasm/out/wasm.js";
import { flagEnabled, FolioContext } from "@/shared";
import { base64ToBytes } from "@/shared/util";

export type JsRewriterOutput = {
	js: Uint8Array;
	map: Uint8Array;
	scramtag: string;
	errors: string[];
};

export interface Rewriter {
	free(): void;
	[Symbol.dispose](): void;
	rewrite_js(
		jsconfig: object,
		jsflags: object,
		encodeUrl: object,
		js: string,
		base: string,
		url: string,
		module: boolean
	): JsRewriterOutput;
	rewrite_js_bytes(
		jsconfig: object,
		jsflags: object,
		encodeUrl: object,
		js: Uint8Array,
		base: string,
		url: string,
		module: boolean
	): JsRewriterOutput;
}

import { URLMeta } from "@rewriters/url";
import { Error } from "@/shared/snapshot";

let wasmSource: Uint8Array | string | undefined;
let initialized = false;
export function setWasm(source: Uint8Array | ArrayBuffer | string) {
	if (!initialized) {
		wasmSource = typeof source === "string" || source instanceof Uint8Array
			? source : new Uint8Array(source);
	}
}

const MAGIC = "\0asm".split("").map((x) => x.charCodeAt(0));

function initWasm() {
	if (initialized) return;
	const wasm_u8 = typeof wasmSource === "string" ? base64ToBytes(wasmSource) : wasmSource;
	if (!(wasm_u8 instanceof Uint8Array))
		throw new Error("rewriter wasm is unavailable /ᐠ - ˕ -マ");

	if (![...wasm_u8.slice(0, 4)].every((x, i) => x === MAGIC[i]))
		throw new Error("rewriter wasm is invalid /ᐠ - ˕ -マ");

	initSync({
		module: wasm_u8,
	});
	initialized = true;
	wasmSource = undefined;
}

type RewriterBox = { rewriter: Rewriter; inUse: boolean };
const rewriters: RewriterBox[] = [];

export function prewarmRewriter(): boolean {
	try {
		initWasm();
		if (rewriters.length === 0) {
			rewriters.push({ rewriter: new WasmRewriter(), inUse: false });
		}
		return true;
	} catch {
		return false;
	}
}

export function getRewriter(
	context: FolioContext,
	meta: URLMeta
): [Rewriter, () => void] {
	initWasm();

	let obj: RewriterBox;
	const index = rewriters.findIndex((x) => !x.inUse);
	const len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			dbg.log(`creating new rewriter, ${len} rewriters made already`);

		const rewriter = new WasmRewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}
