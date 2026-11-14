import { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	FolioFetchHandler,
	FolioFetchParsed,
	FolioFetchRequest,
} from ".";
import {
	flagEnabled,
	IncrementalHtmlRewriter,
	isHtmlMimeType,
	isJavascriptMimeType,
	rewriteCss,
	rewriteHtml,
	rewriteJs,
	rewriteWorkers,
} from "@/shared";
import { sniffEncoding } from "@/shared/sniffEncoding";
import {
	applyImportUrls,
	ServerRewriteError,
	ServerRewriteMode,
	serverRewriteMode,
} from "./serverRewrite";
import { _TextDecoder } from "@/shared/snapshot";

declare const VERSION: string;

const REWRITE_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const REWRITE_CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const HTML_STREAM_SNIFF_BYTES = 1024;
const STREAMED_SCRIPT_BYTES = 2 * 1024 * 1024;
type RewriteCacheBody = string | Uint8Array<ArrayBuffer>;
type RewriteCacheEntry = {
	body: RewriteCacheBody;
	size: number;
};
const rewriteCache = new Map<string, RewriteCacheEntry>();
const pendingRewriteCache = new Map<string, Promise<RewriteCacheBody>>();
let rewriteCacheBytes = 0;

function responseValidator(response: BareResponse): string | null {
	const etag = response.headers.get("etag");
	if (etag) return `etag:${etag}`;
	const lastModified = response.headers.get("last-modified");
	if (lastModified) return `last-modified:${lastModified}`;
	return null;
}

function rewriteFlagsKey(handler: FolioFetchHandler, parsed: FolioFetchParsed) {
	const flags: Record<string, boolean> = {};
	for (const flag of Object.keys(handler.context.config.flags).sort()) {
		flags[flag] = flagEnabled(flag as any, handler.context, parsed.meta.base);
	}
	return JSON.stringify(flags);
}

function rewriteCacheKey(
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	response: BareResponse,
	kind: "script" | "style" | "worker"
): string | null {
	if (parsed.isFakeDataURL) return null;
	const validator = responseValidator(response);
	if (!validator) return null;
	return JSON.stringify({
		kind,
		url: parsed.url.href,
		validator,
		version: typeof VERSION === "string" ? VERSION : "unknown",
		prefix: handler.context.prefix.pathname,
		globals: handler.context.config.globals,
		flags: rewriteFlagsKey(handler, parsed),
		destination: parsed.destination,
		module: parsed.isModule,
		contentType: response.headers.get("content-type") ?? "",
	});
}

function cloneRewriteBody(body: RewriteCacheBody): RewriteCacheBody {
	return typeof body === "string" ? body : body.slice();
}

function ownRewriteBody(body: string | Uint8Array): RewriteCacheBody {
	return typeof body === "string" ? body : Uint8Array.from(body);
}

function rewriteBodySize(body: RewriteCacheBody): number {
	return typeof body === "string" ? body.length * 2 : body.byteLength;
}

function getCachedRewrite(key: string | null): RewriteCacheBody | null {
	if (!key) return null;
	const entry = rewriteCache.get(key);
	if (!entry) return null;
	rewriteCache.delete(key);
	rewriteCache.set(key, entry);
	return cloneRewriteBody(entry.body);
}

function rememberRewrite(key: string | null, body: RewriteCacheBody): void {
	if (!key) return;
	const size = rewriteBodySize(body);
	if (size > REWRITE_CACHE_MAX_ENTRY_BYTES) return;

	const existing = rewriteCache.get(key);
	if (existing) rewriteCacheBytes -= existing.size;

	const entry = { body, size };
	rewriteCache.set(key, entry);
	rewriteCacheBytes += size;

	for (const [oldestKey, oldest] of rewriteCache) {
		if (rewriteCacheBytes <= REWRITE_CACHE_MAX_TOTAL_BYTES) break;
		rewriteCache.delete(oldestKey);
		rewriteCacheBytes -= oldest.size;
	}
}

async function cachedOrPendingRewrite(
	key: string | null,
	producer: () => Promise<RewriteCacheBody> | RewriteCacheBody
): Promise<RewriteCacheBody> {
	const cached = getCachedRewrite(key);
	if (cached) return cached;
	if (!key) return producer();

	const pending = pendingRewriteCache.get(key);
	if (pending) return cloneRewriteBody(await pending);

	const next = Promise.resolve()
		.then(producer)
		.then((body) => {
			rememberRewrite(key, body);
			return body;
		})
		.finally(() => {
			pendingRewriteCache.delete(key);
		});
	pendingRewriteCache.set(key, next);
	return cloneRewriteBody(await next);
}

function htmlRewriteContext(
	parsed: FolioFetchParsed,
	response: BareResponse
) {
	return {
		loadScripts: true,
		inline: true,
		source: parsed.url.href,
		headers: response.rawHeaders,
		history: parsed.trackedClient!.history,
	};
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function rewriteBufferedHtmlBytes(
	bytes: Uint8Array,
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	response: BareResponse
): string {
	const encoding = sniffEncoding(bytes, response.headers.get("content-type"));
	const htmlContent = new _TextDecoder(encoding).decode(bytes);
	return rewriteHtml(
		htmlContent,
		handler.context,
		parsed.meta,
		htmlRewriteContext(parsed, response)
	);
}

async function rewriteHtmlStream(
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	const body = response.body;
	if (!body) {
		return rewriteBufferedHtmlBytes(
			new Uint8Array(await response.arrayBuffer()),
			handler,
			parsed,
			response
		);
	}

	const reader = body.getReader();
	const initialChunks: Uint8Array[] = [];
	let initialBytes = 0;
	let done = false;

	while (initialBytes < HTML_STREAM_SNIFF_BYTES) {
		const result = await reader.read();
		if (result.done) {
			done = true;
			break;
		}
		initialChunks.push(result.value);
		initialBytes += result.value.byteLength;
	}

	if (done) {
		reader.releaseLock();
		return rewriteBufferedHtmlBytes(
			concatChunks(initialChunks),
			handler,
			parsed,
			response
		);
	}

	const sniffBytes = concatChunks(initialChunks);
	initialChunks.length = 0;
	const encoding = sniffEncoding(sniffBytes, response.headers.get("content-type"));
	const decoder = new _TextDecoder(encoding);
	const encoder = new TextEncoder();
	const rewriter = new IncrementalHtmlRewriter(
		handler.context,
		parsed.meta,
		htmlRewriteContext(parsed, response)
	);

	let initial: Uint8Array | null = sniffBytes;
	let cancelled = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				for (;;) {
					const result = initial ? { value: initial, done: false } : await reader.read();
					initial = null;
					if (cancelled) return;
					const html = result.done
						? rewriter.end(decoder.decode())
						: rewriter.write(decoder.decode(result.value, { stream: true }));
					if (html) controller.enqueue(encoder.encode(html));
					if (result.done) {
						reader.releaseLock();
						controller.close();
						return;
					}
					if (html) return;
				}
			} catch (err) {
				if (!cancelled) {
					controller.error(err);
					try { await reader.cancel(); } finally { reader.releaseLock(); }
				}
			}
		},
		async cancel(reason) {
			cancelled = true;
			initial = null;
			try { await reader.cancel(reason); } finally { reader.releaseLock(); }
		},
	}, { highWaterMark: 0 });
}

async function serverRewrittenBytes(
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed,
	response: BareResponse,
	mode: ServerRewriteMode,
	refetch?: () => Promise<BareResponse>
): Promise<Uint8Array<ArrayBuffer> | BareResponse> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (mode === "final") return bytes;
	try {
		return applyImportUrls(
			bytes,
			handler.context,
			parsed.meta
		) as Uint8Array<ArrayBuffer>;
	} catch (error) {
		if (!(error instanceof ServerRewriteError) || !refetch) throw error;
		return refetch();
	}
}

export async function rewriteBody(
	handler: FolioFetchHandler,
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	response: BareResponse,
	refetch?: () => Promise<BareResponse>
): Promise<BodyType> {
	switch (parsed.destination) {
		case "iframe":
		case "document":
			if (isHtmlMimeType(response.headers.get("content-type") ?? "")) {
				return rewriteHtmlStream(handler, parsed, response);
			} else {
				return response.body;
			}
		case "script": {
			const served = serverRewriteMode(
				handler,
				parsed,
				request.method,
				response
			);
			if (served === "final") {
				const length = Number(response.headers.get("content-length"));
				return length >= STREAMED_SCRIPT_BYTES
					? response.body
					: response.arrayBuffer();
			}
			if (served) {
				const patched = await serverRewrittenBytes(
					handler,
					parsed,
					response,
					served,
					refetch
				);
				if (patched instanceof Uint8Array) {
					return patched.buffer.slice(
						patched.byteOffset,
						patched.byteOffset + patched.byteLength
					);
				}
				response = patched;
			}
			if (response.ok) {
				const ct = response.headers.get("content-type");
				if (parsed.isModule && ct && !isJavascriptMimeType(ct)) {
					return response.body;
				}
				const cacheKey = rewriteCacheKey(handler, parsed, response, "script");

				const rewritten = await cachedOrPendingRewrite(cacheKey, async () => {
					let rewritten = rewriteJs(
						new Uint8Array(await response.arrayBuffer()),
						response.url,
						handler.context,
						parsed.meta,
						parsed.isModule
					);

					if (
						flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
					) {
						if (rewritten instanceof Uint8Array) {
							rewritten = new TextDecoder().decode(rewritten);
						}
						rewritten += `\n//# sourceURL=${parsed.url.href}`;
					}

					return ownRewriteBody(rewritten);
				});
				return rewritten;
			}
			return response.body;
		}
		case "style":
			{
				const cacheKey = rewriteCacheKey(handler, parsed, response, "style");
				const rewritten = await cachedOrPendingRewrite(cacheKey, async () =>
					rewriteCss(await response.text(), handler.context, parsed.meta)
				);
				return rewritten;
			}
		case "sharedworker":
		case "worker":
			{
				const served = serverRewriteMode(
					handler,
					parsed,
					request.method,
					response
				);
				if (served) {
					const rewritten = await serverRewrittenBytes(
						handler,
						parsed,
						response,
						served,
						refetch
					);
					if (rewritten instanceof Uint8Array) {
						return rewriteWorkers(
							rewritten,
							response.url,
							handler.context,
							parsed.meta,
							parsed.isModule,
							true
						);
					}
					response = rewritten;
				}
				const cacheKey = rewriteCacheKey(handler, parsed, response, "worker");
				const rewritten = await cachedOrPendingRewrite(cacheKey, async () =>
					ownRewriteBody(rewriteWorkers(
						new Uint8Array(await response.arrayBuffer()),
						response.url,
						handler.context,
						parsed.meta,
						parsed.isModule
					))
				);
				return rewritten;
			}
		default:
			return response.body;
	}
}
