import { BareResponse, type FolioFetchRequest } from "@mercuryworkshop/folio";
import { ManagedPlugin } from "@mercuryworkshop/folio-controller";
import type { Frame } from "@mercuryworkshop/folio-controller";

export const CACHE_NAME = "folio-http-cache-v4";
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const STORED_AT_HEADER = "x-fl-cached-at";
const SERVER_REWRITTEN_HEADER = "x-mochi-folio-rewritten";
const SERVER_REWRITE_INTENT_HEADER = "x-mochi-folio-rewrite";
const CACHEABLE_STATUSES = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
let cacheGeneration = 0;

function directives(value: string | null): Map<string, string> {
	const result = new Map<string, string>();
	for (const part of (value ?? "").split(",")) {
		const eq = part.indexOf("=");
		const name = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
		const value = eq < 0 ? "" : part.slice(eq + 1).trim().replace(/^"|"$/g, "");
		if (result.has(name)) result.set("no-cache", "");
		result.set(name, value);
	}
	return result;
}

function seconds(value: string | null | undefined): number | null {
	return value != null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
		? Number(value) : null;
}

function lifetime(headers: Headers, receivedAt: number): number {
	const cc = directives(headers.get("cache-control"));
	if (cc.has("max-age")) return seconds(cc.get("max-age")) ?? 0;
	const expires = Date.parse(headers.get("expires") ?? "");
	const date = Date.parse(headers.get("date") ?? "");
	return Number.isFinite(expires)
		? Math.max(0, (expires - (Number.isFinite(date) ? date : receivedAt)) / 1000) : 0;
}

function age(headers: Headers, receivedAt: number): number {
	const date = Date.parse(headers.get("date") ?? "");
	const apparent = Number.isFinite(date) ? Math.max(0, (receivedAt - date) / 1000) : 0;
	const upstream = headers.has("age") ? seconds(headers.get("age")) ?? Infinity : 0;
	return Math.max(apparent, upstream) + Math.max(0, (Date.now() - receivedAt) / 1000);
}

function cacheKey(url: string, headers: Headers): Request {
	return new Request("https://fl-cache.invalid/" + encodeURIComponent(url), { headers });
}

function rawHeaders(raw: ReadonlyArray<readonly [string, string]>): Headers {
	const headers = new Headers();
	for (const [name, value] of raw) {
		try { headers.append(name, value); } catch {}
	}
	return headers;
}

function storable(status: number, headers: Headers, limit: number): boolean {
	if (!CACHEABLE_STATUSES.has(status) || headers.has("set-cookie") || headers.has("content-range")) return false;
	if (directives(headers.get("cache-control")).has("no-store")) return false;
	if ((headers.get("vary") ?? "").split(",").some(value => value.trim() === "*")) return false;
	const length = seconds(headers.get("content-length"));
	return NULL_BODY_STATUSES.has(status) || (length !== null && length <= limit);
}

function bareResponse(body: BodyInit | null, status: number, statusText: string, headers: Headers, url: string): BareResponse {
	const response = BareResponse.fromNativeResponse(new Response(body, { status, statusText, headers }));
	response.url = url;
	return response;
}

interface CacheRequest {
	key: Request;
	url: string;
	startedAt: number;
	generation: number;
	stored?: Response;
	validator?: string;
}

export interface HttpCachePluginOptions {
	cacheName?: string;
	maxEntryBytes?: number;
}

export class HttpCachePlugin extends ManagedPlugin {
	readonly cacheName: string;
	readonly maxEntryBytes: number;
	private cachePromise: Promise<Cache> | null = null;
	private requests = new WeakMap<FolioFetchRequest, CacheRequest>();
	private hits = new WeakSet<FolioFetchRequest>();

	constructor(options: HttpCachePluginOptions = {}) {
		super("folio-http-cache", []);
		this.cacheName = options.cacheName ?? CACHE_NAME;
		this.maxEntryBytes = Math.max(0, options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES);
	}

	private openCache(): Promise<Cache> {
		return this.cachePromise ??= caches.open(this.cacheName).catch(error => {
			this.cachePromise = null;
			throw error;
		});
	}

	private async store(entry: CacheRequest, response: Response): Promise<void> {
		try {
			const cache = await this.openCache();
			if (entry.generation !== cacheGeneration) return;
			await cache.put(entry.key, response);
			if (entry.generation !== cacheGeneration) await cache.delete(entry.key, { ignoreVary: true });
		} catch {
		}
	}

	install(frame: Frame): void {
		super.install(frame);
		const hooks = frame.fetchHandler.hooks.fetch;
		this.tap(hooks.request, async (ctx, props) => {
			const req = ctx.request;
			if (props.earlyResponse) return;
			const headers = rawHeaders(props.init.headers ?? []);
			const cc = directives(headers.get("cache-control"));
			const mode = req.cache as string;
			const cacheOnly = mode === "only-if-cached" || cc.has("only-if-cached");
			const miss = () => {
				if (!cacheOnly) return;
				props.earlyResponse = bareResponse(null, 504, "", new Headers(), props.url.href);
				this.hits.add(req);
			};
			if (mode === "no-store" || mode === "reload" || mode === "no-cache") {
				headers.append("cache-control", mode === "no-store" ? "no-store" : "no-cache");
				props.init.headers = [...headers];
			}
			if ((req.method !== "GET" && req.method !== "HEAD")
				|| mode === "no-store" || cc.has("no-store")
				|| ["cookie", "authorization", "proxy-authorization", "range", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"].some(name => headers.has(name))
				|| ctx.parsed.destination === "audio" || ctx.parsed.destination === "video") {
				miss();
				return;
			}
			const entry: CacheRequest = {
				key: cacheKey(props.url.href, headers), url: props.url.href,
				startedAt: Date.now(), generation: cacheGeneration,
			};
			this.requests.set(req, entry);
			try {
				const cache = await this.openCache();
				const stored = mode === "reload" ? undefined : await cache.match(entry.key);
				if (stored) {
					const receivedAt = Number(stored.headers.get(STORED_AT_HEADER));
					const responseCc = directives(stored.headers.get("cache-control"));
					const currentAge = age(stored.headers, receivedAt);
					const maxAge = cc.has("max-age") ? seconds(cc.get("max-age")) ?? 0 : Infinity;
					const minFresh = cc.has("min-fresh") ? seconds(cc.get("min-fresh")) ?? Infinity : 0;
					const fresh = entry.generation === cacheGeneration && receivedAt > 0 && !responseCc.has("no-cache") && !responseCc.has("no-store")
						&& !cc.has("no-cache") && mode !== "no-cache"
						&& !(headers.get("pragma") ?? "").toLowerCase().includes("no-cache")
						&& !(stored.headers.get("pragma") ?? "").toLowerCase().includes("no-cache")
						&& currentAge <= maxAge && currentAge + minFresh < lifetime(stored.headers, receivedAt);
					if (fresh && storable(stored.status, stored.headers, this.maxEntryBytes)) {
						const output = new Headers(stored.headers);
						output.delete(STORED_AT_HEADER);
						output.set("age", String(Math.floor(currentAge)));
						props.earlyResponse = bareResponse(req.method === "HEAD" ? null : stored.body, stored.status, stored.statusText, output, entry.url);
						this.hits.add(req);
						return;
					}
					const etag = stored.headers.get("etag");
					const modified = stored.headers.get("last-modified");
					if (req.method === "GET" && (etag || modified) && storable(stored.status, stored.headers, this.maxEntryBytes)) {
						entry.stored = stored;
						entry.validator = etag ?? undefined;
						headers.set(etag ? "if-none-match" : "if-modified-since", (etag ?? modified)!);
						props.init.headers = [...headers];
					}
				}
				miss();
			} catch {
				miss();
			}
		}, { after: ["rivet-declarative-net-request"] });

		this.tap(hooks.preresponse, async (ctx, props) => {
			const req = ctx.request;
			if (this.hits.delete(req)) {
				this.requests.delete(req);
				return;
			}
			const entry = this.requests.get(req);
			this.requests.delete(req);
			if (!["GET", "HEAD", "OPTIONS", "TRACE"].includes(req.method)) {
				if (props.response.status >= 200 && props.response.status < 400) {
					cacheGeneration++;
					try {
						const cache = await this.openCache();
						const url = ctx.parsed.url;
						const targets = new Set([url.href]);
						for (const [name, value] of props.response.rawHeaders) {
							if (!["location", "content-location"].includes(name.toLowerCase())) continue;
							try {
								const target = new URL(value, url);
								if (target.origin === url.origin) targets.add(target.href);
							} catch {}
						}
						await Promise.all([...targets].map(url => cache.delete(cacheKey(url, new Headers()), { ignoreVary: true })));
					} catch {}
				}
				return;
			}
			if (!entry) return;
			if (req.method === "HEAD") {
				if (props.response.status >= 200 && props.response.status < 400) {
					try { await (await this.openCache()).delete(entry.key, { ignoreVary: true }); } catch {}
				}
				return;
			}
			const receivedAt = Date.now();
			let response = props.response;
			if (response.status === 304 && entry.stored) {
				const updated = rawHeaders(response.rawHeaders);
				if (updated.has("etag") && entry.validator && updated.get("etag") !== entry.validator) {
					props.response = bareResponse(null, 502, "", new Headers({ "cache-control": "no-store" }), entry.url);
					return;
				}
				const merged = new Headers(entry.stored.headers);
				merged.delete("age");
				merged.delete("date");
				merged.delete(STORED_AT_HEADER);
				for (const [name, value] of updated) merged.set(name, value);
				response = bareResponse(entry.stored.body, entry.stored.status, entry.stored.statusText, merged, entry.url);
				props.response = response;
			}
			try { await (await this.openCache()).delete(entry.key, { ignoreVary: true }); } catch {}
			const headers = rawHeaders(response.rawHeaders);
			if (
				headers.has(SERVER_REWRITTEN_HEADER) &&
				!(headers.get("vary") ?? "").toLowerCase().includes(SERVER_REWRITE_INTENT_HEADER)
			) {
				headers.append("vary", SERVER_REWRITE_INTENT_HEADER);
			}
			if (!storable(response.status, headers, this.maxEntryBytes)) return;
			const upstreamAge = headers.has("age") ? seconds(headers.get("age")) ?? Infinity : 0;
			const correctedAge = Math.max(age(headers, receivedAt), upstreamAge + Math.max(0, receivedAt - entry.startedAt) / 1000);
			if (!Number.isFinite(correctedAge)) return;
			headers.set("age", String(Math.ceil(correctedAge)));
			headers.set(STORED_AT_HEADER, String(receivedAt));
			const status = response.status;
			const statusText = response.statusText;
			if (!response.body) {
				void this.store(entry, new Response(null, { status, statusText, headers }));
				return;
			}
			let chunks: Uint8Array[] = [];
			let length = 0;
			const limit = this.maxEntryBytes;
			const store = (body: Blob) => this.store(entry, new Response(body, { status, statusText, headers }));
			const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					length += chunk.byteLength;
					if (length <= limit) chunks.push(chunk.slice());
					else chunks = [];
					controller.enqueue(chunk);
				},
				flush() {
					if (length <= limit) {
						headers.set("content-length", String(length));
						void store(new Blob(chunks as BlobPart[]));
					}
					chunks = [];
				},
			}));
			const replacement = bareResponse(stream, status, statusText, rawHeaders(response.rawHeaders), response.url);
			replacement.rawHeaders = response.rawHeaders;
			replacement.redirected = response.redirected;
			props.response = replacement;
		}, { before: ["rivet-declarative-net-request"] });
	}

	async bust(): Promise<boolean> {
		cacheGeneration++;
		this.cachePromise = null;
		try { return await caches.delete(this.cacheName); } catch { return false; }
	}
}
