import {
	rewriteUrl,
	FolioContext,
	FolioHeaders,
	unrewriteUrl,
	URLMeta,
	registrableDomain,
} from "@/shared";
import {
	FolioFetchHandler,
	FolioFetchParsed,
	FolioFetchRequest,
} from ".";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { _URL, _Set } from "@/shared/snapshot";
import { createReferrerString } from "./util";
import { SERVER_REWRITTEN_HEADER } from "./serverRewrite";

const SEC_HEADERS = new _Set([
	"cross-origin-embedder-policy",
	"cross-origin-opener-policy",
	"cross-origin-resource-policy",
	"content-security-policy",
	"content-security-policy-report-only",
	"expect-ct",
	"feature-policy",
	"origin-isolation",
	"strict-transport-security",
	"upgrade-insecure-requests",
	"x-content-type-options",
	"x-download-options",
	"x-frame-options",
	"x-permitted-cross-domain-policies",
	"x-powered-by",
	"x-xss-protection",
	"clear-site-data",
]) as _Set<string>;

const URL_HEADERS = new _Set([
	"location",
	"content-location",
	"referer",
]) as _Set<string>;

function rewriteLinkHeader(
	link: string,
	context: FolioContext,
	meta: URLMeta
) {
	return link.replace(/<([^>]+)>/gi, (_match, p1) => {
		return `<${rewriteUrl(p1, context, meta)}>`;
	});
}

export async function rewriteResponseHeaders(
	handler: FolioFetchHandler,
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	rawHeaders: RawHeaders
): Promise<FolioHeaders> {
	const headers = FolioHeaders.fromRawHeaders(rawHeaders);

	for (const cspHeader of SEC_HEADERS) {
		headers.delete(cspHeader);
	}

	for (const urlHeader of URL_HEADERS) {
		if (headers.has(urlHeader)) {
			const url = headers.get(urlHeader)!;
			const rewrittenUrl = rewriteUrl(url, handler.context, parsed.meta);
			headers.set(urlHeader, rewrittenUrl);
		}
	}

	if (headers.has("link")) {
		const link = headers.get("link")!;
		const rewritten = rewriteLinkHeader(link, handler.context, parsed.meta);
		headers.set("link", rewritten);
	}

	if (headers.get("accept") === "text/event-stream") {
		headers.set("content-type", "text/event-stream");
	}

	headers.delete("permissions-policy");

	headers.delete("set-cookie");

	if (headers.get(SERVER_REWRITTEN_HEADER) === "2") {
		headers.delete("content-length");
	}
	headers.delete(SERVER_REWRITTEN_HEADER);

	if (
		handler.crossOriginIsolated &&
		[
			"document",
			"iframe",
			"worker",
			"sharedworker",
			"style",
			"script",
		].includes(parsed.destination)
	) {
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
	}

	if (parsed.destination === "document" || parsed.destination === "iframe") {
		headers.set("Referrer-Policy", "unsafe-url");
	}

	return headers;
}

export function rewriteRequestHeaders(
	request: FolioFetchRequest,
	handler: FolioFetchHandler,
	parsed: FolioFetchParsed
): FolioHeaders {
	const headers = request.initialHeaders.clone();

	headers.delete("Referer");

	const rawOriginUrl =
		parsed.referrerSourceUrl !== undefined
			? parsed.referrerSourceUrl
			: request.rawClientUrl ||
				(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
	const originUrl =
		rawOriginUrl &&
		rawOriginUrl.pathname.startsWith(handler.context.prefix.pathname)
			? new _URL(unrewriteUrl(rawOriginUrl, handler.context))
			: rawOriginUrl;

	if (
		rawOriginUrl &&
		rawOriginUrl.pathname.startsWith(handler.context.prefix.pathname)
	) {
		if (requestSendsOrigin(request, parsed, originUrl)) {
			headers.set("Origin", originUrl.origin);
		} else {
			headers.delete("Origin");
		}

		const referer = createReferrerString(
			originUrl,
			parsed.url,
			parsed.referrerPolicy ?? null
		);
		if (referer) headers.set("Referer", referer);
	}

	const sameSiteContext = computeSameSiteContext(request, parsed, originUrl);
	const cookies = handler.context.cookieJar.getCookies(
		parsed.url,
		false,
		sameSiteContext
	);

	if (cookies.length) {
		headers.set("Cookie", cookies);
	}

	applyFetchMetadataHeaders(headers, request, parsed, handler);
	applyBrowserHeaders(headers, parsed);

	return headers;
}

type BrowserNavigator = Navigator & {
	userAgentData?: {
		brands: { brand: string; version: string }[];
		mobile: boolean;
		platform: string;
	};
};

function formatAcceptLanguage(languages: readonly string[]): string {
	return languages
		.map((language, i) =>
			i === 0 ? language : `${language};q=${Math.max(1, 10 - i) / 10}`
		)
		.join(",");
}

function applyBrowserHeaders(headers: FolioHeaders, parsed: FolioFetchParsed) {
	const browser = globalThis.navigator as BrowserNavigator | undefined;
	if (!browser) return;

	if (!headers.has("user-agent") && browser.userAgent) {
		headers.set("User-Agent", browser.userAgent);
	}

	if (!headers.has("accept-language")) {
		const languages = browser.languages?.length
			? browser.languages
			: browser.language
				? [browser.language]
				: [];
		if (languages.length) {
			headers.set("Accept-Language", formatAcceptLanguage(languages));
		}
	}

	const userAgentData = browser.userAgentData;
	if (
		userAgentData &&
		isPotentiallyTrustworthy(parsed.url) &&
		!headers.has("sec-ch-ua")
	) {
		headers.set(
			"sec-ch-ua",
			userAgentData.brands
				.map(({ brand, version }) => `"${brand}";v="${version}"`)
				.join(", ")
		);
		headers.set("sec-ch-ua-mobile", userAgentData.mobile ? "?1" : "?0");
		headers.set("sec-ch-ua-platform", `"${userAgentData.platform}"`);
	}
}

function applyFetchMetadataHeaders(
	headers: FolioHeaders,
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	handler: FolioFetchHandler
) {
	headers.delete("sec-fetch-site");
	headers.delete("sec-fetch-mode");
	headers.delete("sec-fetch-dest");
	headers.delete("sec-fetch-user");
	headers.delete("sec-fetch-storage-access");

	if (!isPotentiallyTrustworthy(parsed.url)) {
		return;
	}

	const initiatorUrl = resolveFetchInitiatorUrl(request, parsed, handler);

	let site: "none" | "same-origin" | "same-site" | "cross-site";
	if (!initiatorUrl) {
		site = "none";
	} else {
		const immediate = computeFetchSite(initiatorUrl, parsed.url);
		site = parsed.fetchSiteState
			? worstFetchSite(parsed.fetchSiteState, immediate)
			: immediate;
	}
	headers.set("Sec-Fetch-Site", site);

	headers.set("Sec-Fetch-Mode", computeFetchMode(request, parsed));

	if (parsed.destination === "iframe") {
		if (!parsed.isIframe) {
			headers.set("Sec-Fetch-Dest", "document");
		} else {
			headers.set("Sec-Fetch-Dest", "iframe");
		}
	} else {
		headers.set("Sec-Fetch-Dest", parsed.destination || "empty");
	}

	const isNavigationDestination =
		parsed.destination === "document" ||
		parsed.destination === "iframe" ||
		parsed.destination === "frame" ||
		parsed.destination === "embed" ||
		parsed.destination === "object";
	if (
		isNavigationDestination &&
		request.initialHeaders.get("sec-fetch-user") === "?1"
	) {
		headers.set("Sec-Fetch-User", "?1");
	}

	if (site === "cross-site" && requestIncludesCredentials(request, parsed)) {
		headers.set("Sec-Fetch-Storage-Access", "none");
	}
}

function requestIncludesCredentials(
	request: FolioFetchRequest,
	parsed: FolioFetchParsed
): boolean {
	if (parsed.fetchCredentialsInclude) return true;
	const dest = parsed.destination;
	if (dest === "" || dest === "report") return false;
	if (parsed.isModule) return false;
	return true;
}

function requestSendsOrigin(
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	originUrl: URL
): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return true;
	return (
		computeFetchMode(request, parsed) === "cors" &&
		originUrl.origin !== parsed.url.origin
	);
}

function computeFetchMode(
	request: FolioFetchRequest,
	parsed: FolioFetchParsed
): string {
	if (parsed.fetchMode) return parsed.fetchMode;
	const dest = parsed.destination;
	if (
		dest === "document" ||
		dest === "iframe" ||
		dest === "frame" ||
		dest === "embed" ||
		dest === "object"
	) {
		return "navigate";
	}
	if (dest === "worker" || dest === "sharedworker") {
		return parsed.isModule ? "cors" : "same-origin";
	}
	if (request.mode === "cors" || request.mode === "no-cors") {
		return request.mode;
	}
	return "no-cors";
}

function resolveFetchInitiatorUrl(
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	handler: FolioFetchHandler
): URL | undefined {
	if (parsed.fetchInitiatorOrigin) {
		try {
			return new _URL(parsed.fetchInitiatorOrigin);
		} catch {
			// fall through to the fallbacks below
		}
	}
	const candidate =
		request.rawClientUrl ||
		(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
	if (!candidate) return undefined;
	if (candidate.pathname.startsWith(handler.context.prefix.pathname)) {
		return new _URL(unrewriteUrl(candidate, handler.context));
	}
	return undefined;
}

function isPotentiallyTrustworthy(url: URL): boolean {
	const protocol = url.protocol;
	if (protocol === "https:" || protocol === "wss:" || protocol === "file:") {
		return true;
	}
	if (protocol !== "http:" && protocol !== "ws:") {
		return false;
	}
	return isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "localhost.") return true;
	if (hostname.endsWith(".localhost") || hostname.endsWith(".localhost.")) {
		return true;
	}
	if (hostname === "[::1]" || hostname === "::1") return true;
	if (/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(hostname)) {
		return true;
	}
	return false;
}

export function computeFetchSite(
	originUrl: URL,
	destUrl: URL
): "same-origin" | "same-site" | "cross-site" {
	if (
		originUrl.protocol === destUrl.protocol &&
		originUrl.host === destUrl.host
	) {
		return "same-origin";
	}
	if (
		originUrl.protocol === destUrl.protocol &&
		registrableDomain(originUrl.hostname) ===
			registrableDomain(destUrl.hostname)
	) {
		return "same-site";
	}
	return "cross-site";
}

export function worstFetchSite(
	a: "none" | "same-origin" | "same-site" | "cross-site",
	b: "none" | "same-origin" | "same-site" | "cross-site"
): "none" | "same-origin" | "same-site" | "cross-site" {
	const order = { "cross-site": 0, "same-site": 1, "same-origin": 2, none: 3 };
	return order[a] <= order[b] ? a : b;
}

function computeSameSiteContext(
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	rawOriginUrl: URL | undefined
): "strict" | "lax" | "cross-site" {
	if (parsed.crossSiteRedirect) {
		const isNavigation =
			parsed.destination === "document" || parsed.destination === "iframe";
		const isSafeMethod = request.method === "GET" || request.method === "HEAD";
		return isNavigation && isSafeMethod ? "lax" : "cross-site";
	}

	if (!rawOriginUrl) return "strict";

	const originSite = registrableDomain(rawOriginUrl.hostname);
	const targetSite = registrableDomain(parsed.url.hostname);

	if (originSite === targetSite) return "strict";

	const isNavigation =
		parsed.destination === "document" || parsed.destination === "iframe";
	const isSafeMethod = request.method === "GET" || request.method === "HEAD";

	if (isNavigation && isSafeMethod) return "lax";
	return "cross-site";
}
