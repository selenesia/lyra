import { BareResponse } from "@mercuryworkshop/proxy-transports";
import { FolioFetchHandler, FolioFetchParsed } from ".";
import { flagEnabled, FolioContext } from "@/shared";
import { rewriteUrl, URLMeta } from "@rewriters/url";
import { base64Encode } from "@/shared/util";
import { QP } from "./parse";

declare const FOLIO_REWRITER_HASH: string | undefined;

export const SERVER_REWRITE_INTENT_HEADER = "x-mochi-folio-rewrite";
export const SERVER_REWRITTEN_HEADER = "x-mochi-folio-rewritten";

const REWRITER_FLAGS = [
	"sourcemaps",
	"captureErrors",
	"scramitize",
	"disableComputedWrap",
	"destructureRewrites",
] as const;
const REWRITER_GLOBALS = [
	"wrapfn",
	"wrappropertybase",
	"wrappropertyfn",
	"cleanrestfn",
	"importfn",
	"rewritefn",
	"wrappostmessagefn",
	"metafn",
	"pushsourcemapfn",
	"trysetfn",
	"errfn",
	"setrealmfn",
	"templocid",
	"tempunusedid",
] as const;
const MAX_BASE_LENGTH = 2048;
const SEAL_OVERHEAD_BYTES = 40;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const BACKSLASH = 0x5c;
const SPACE = 0x20;

export type ServerRewriteMode = "final" | "patch";

export class ServerRewriteError extends Error {
	constructor() {
		super("server rewrite frame is invalid... /ᐠ - ˕ -マ");
	}
}

function rewriterBuild(handler: FolioFetchHandler): string | null {
	if (typeof FOLIO_REWRITER_HASH !== "string") return null;
	const transport = handler.client.transport as { folioRewriter?: unknown };
	return transport.folioRewriter === FOLIO_REWRITER_HASH
		? FOLIO_REWRITER_HASH
		: null;
}

function isWorker(parsed: FolioFetchParsed): boolean {
	return (
		parsed.destination === "worker" || parsed.destination === "sharedworker"
	);
}

function serverRewriteApplies(
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	method: string
): boolean {
	if (method !== "GET" || parsed.isFakeDataURL) return false;
	if (!isWorker(parsed) && parsed.destination !== "script") return false;
	if (!rewriterBuild(handler)) return false;
	const context = handler.context;
	const base = parsed.meta.base;
	if (base.protocol !== "http:" && base.protocol !== "https:") return false;
	if (base.href.length > MAX_BASE_LENGTH) return false;
	if (flagEnabled("rewriterLogs", context, base)) return false;
	if (
		!isWorker(parsed) &&
		flagEnabled("debugSourceURL", context, parsed.meta.origin)
	) {
		return false;
	}
	return !(
		flagEnabled("sourcemaps", context, base) &&
		globalThis[context.config.globals.pushsourcemapfn]
	);
}

export function sealedUrlModel(
	context: FolioContext,
	meta: URLMeta
): { fixed: number; sealed: number } | null {
	const route = context.prefix.pathname.match(
		/^(.*\/f)\/[a-z0-9]+\/[a-z0-9]+\/$/
	);
	if (!route) return null;
	const params = new URLSearchParams();
	params.set(QP.isModule, "module");
	if (meta.origin.origin !== context.prefix.origin) {
		params.set(QP.initiatorOrigin, meta.origin.origin);
	}
	return {
		fixed: (context.prefix.origin + route[1] + "?s=").length,
		sealed:
			SEAL_OVERHEAD_BYTES +
			context.prefix.pathname.length +
			1 +
			params.toString().length,
	};
}

export function serverRewriteIntent(
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	method: string
): string | null {
	if (!serverRewriteApplies(handler, parsed, method)) return null;
	const context = handler.context;
	const base = parsed.meta.base;
	const flags: Record<string, boolean> = {};
	for (const flag of REWRITER_FLAGS) {
		flags[flag] = flagEnabled(flag, context, base);
	}
	const config: Record<string, string> = {};
	for (const name of REWRITER_GLOBALS) {
		config[name] = context.config.globals[name];
	}
	const intent = {
		v: 1,
		rewriter: rewriterBuild(handler),
		kind: isWorker(parsed) ? "worker" : "script",
		module: parsed.isModule,
		base: base.href,
		flags,
		config,
		urls: parsed.isModule
			? (sealedUrlModel(context, parsed.meta) ?? undefined)
			: undefined,
	};
	return base64Encode(JSON.stringify(intent))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function serverRewriteMode(
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	method: string,
	response: BareResponse
): ServerRewriteMode | null {
	const marker = response.headers.get(SERVER_REWRITTEN_HEADER);
	if (marker !== "1" && marker !== "2") return null;
	if (!serverRewriteApplies(handler, parsed, method)) return null;
	return marker === "1" ? "final" : "patch";
}

function importTable(frame: Uint8Array): [unknown[], Uint8Array] {
	if (frame.byteLength < 4) throw new ServerRewriteError();
	const tableLength = new DataView(
		frame.buffer,
		frame.byteOffset,
		frame.byteLength
	).getUint32(0);
	if (tableLength > frame.byteLength - 4) throw new ServerRewriteError();
	let table: unknown;
	try {
		table = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				frame.subarray(4, 4 + tableLength)
			)
		);
	} catch {
		throw new ServerRewriteError();
	}
	if (!Array.isArray(table)) throw new ServerRewriteError();
	return [table, frame.subarray(4 + tableLength)];
}

export function applyImportUrls(
	frame: Uint8Array,
	context: FolioContext,
	meta: URLMeta
): Uint8Array {
	const [table, js] = importTable(frame);
	const encoder = new TextEncoder();
	let cursor = 0;
	for (const entry of table) {
		if (!Array.isArray(entry) || entry.length !== 4) {
			throw new ServerRewriteError();
		}
		const [offset, width, url, isModule] = entry as unknown[];
		if (
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(width) ||
			typeof url !== "string" ||
			typeof isModule !== "boolean" ||
			(offset as number) < cursor ||
			(width as number) < 1 ||
			(offset as number) + (width as number) >= js.byteLength
		) {
			throw new ServerRewriteError();
		}
		const start = offset as number;
		const end = start + (width as number);
		const quote = js[end];
		if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) {
			throw new ServerRewriteError();
		}
		const sealed = encoder.encode(rewriteUrl(url, context, meta, { isModule }));
		if (sealed.byteLength > end - start) throw new ServerRewriteError();
		if (sealed.byteLength < end - start) {
			for (const byte of sealed) {
				if (byte === quote || byte === BACKSLASH || byte === 0x0a || byte === 0x0d) {
					throw new ServerRewriteError();
				}
			}
			js[start + sealed.byteLength] = quote;
			js.fill(SPACE, start + sealed.byteLength + 1, end + 1);
		}
		js.set(sealed, start);
		cursor = end + 1;
	}
	return js;
}
