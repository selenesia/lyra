import { openRoute, sealRoute } from "@/shared/route";
import {
	BareRequestInit,
	BareResponse,
	RawHeaders,
} from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	FolioFetchHandler,
	FolioFetchParsed,
	FolioFetchRequest,
	FolioFetchResponse,
} from ".";
import { rewriteUrl, unrewriteBlob, unrewriteUrl } from "@rewriters/url";
import { QP, parseRequest } from "./parse";
import { FolioHeaders, registrableDomain } from "@/shared";
import { isDocument, isRedirect, normalizeContentType } from "./util";
import { rewriteBody } from "./body";
import { Tap } from "@/Tap";
import {
	computeFetchSite,
	rewriteRequestHeaders,
	rewriteResponseHeaders,
	worstFetchSite,
} from "./headers";
import { _URL } from "@/shared/snapshot";
import {
	SERVER_REWRITE_INTENT_HEADER,
	serverRewriteIntent,
} from "./serverRewrite";

export async function doHandleFetch(
	handler: FolioFetchHandler,
	request: FolioFetchRequest
): Promise<FolioFetchResponse> {
	request = { ...request, rawUrl: openRoute(request.rawUrl),
		rawClientUrl: request.rawClientUrl ? openRoute(request.rawClientUrl) : undefined,
		rawReferrer: request.rawReferrer ? openRoute(request.rawReferrer).href : request.rawReferrer };
	const parsed = parseRequest(request, handler);

	if (isBlobOrDataUrl(parsed.url)) {
		return handleBlobOrDataUrlFetch(handler, request, parsed);
	}

	const interceptCtx: typeof handler.hooks.fetch.intercept.context = {
		request,
		parsed,
	};
	const interceptProps: typeof handler.hooks.fetch.intercept.props = {};
	await Tap.dispatch(
		handler.hooks.fetch.intercept,
		interceptCtx,
		interceptProps
	);
	if (interceptProps.response) {
		return interceptProps.response;
	}

	if (parsed.hadExtraParams && isDocument(parsed)) {
		const location = rewriteUrl(parsed.url, handler.context, parsed.meta);
		if (location !== request.rawUrl.href) {
			const responseHeaders = new FolioHeaders();
			responseHeaders.set("location", location);
			return {
				body: "",
				headers: responseHeaders,
				status: 307,
				statusText: "Temporary Redirect",
			};
		}
	}

	const newheaders = rewriteRequestHeaders(request, handler, parsed);

	let responseBody: BodyType;
	const response = await doNetworkFetch(handler, request, parsed, newheaders);

	await handleCookies(handler, request, parsed, response.rawHeaders);

	if (isDocument(parsed)) {
		parsed.trackedClient?.history.push({
			url: parsed.url.href,
			refererPolicy: FolioHeaders.fromRawHeaders(response.rawHeaders).get(
				"referrer-policy"
			),
		});
		if (parsed.trackedClient && parsed.trackedClient.history.length > 64) {
			parsed.trackedClient.history.splice(
				0,
				parsed.trackedClient.history.length - 64
			);
		}
	}

	const responseHeaders = await rewriteResponseHeaders(
		handler,
		request,
		parsed,
		response.rawHeaders
	);

	if (isRedirect(response)) {
		const location = openRoute(responseHeaders.get("location"));
		const referer = newheaders.get("Referer");

		let initiatorOriginUrl: URL | undefined;
		if (parsed.fetchInitiatorOrigin) {
			try {
				initiatorOriginUrl = new URL(parsed.fetchInitiatorOrigin);
			} catch {
				initiatorOriginUrl = undefined;
			}
		}
		if (!initiatorOriginUrl) {
			const rawClient =
				request.rawClientUrl ||
				(request.rawReferrer ? new URL(request.rawReferrer) : undefined);
			initiatorOriginUrl =
				rawClient &&
				rawClient.pathname.startsWith(handler.context.prefix.pathname)
					? new URL(unrewriteUrl(rawClient, handler.context))
					: undefined;
		}

		const crossSiteRedirect =
			parsed.crossSiteRedirect ||
			(!!initiatorOriginUrl &&
				registrableDomainForRedirect(initiatorOriginUrl.hostname) !==
					registrableDomainForRedirect(parsed.url.hostname));

		let propagatedFetchSite: "same-site" | "cross-site" | undefined;
		if (initiatorOriginUrl) {
			const hopSite = computeFetchSite(initiatorOriginUrl, parsed.url);
			const propagated = parsed.fetchSiteState
				? worstFetchSite(parsed.fetchSiteState, hopSite)
				: hopSite;
			if (propagated !== "same-origin" && propagated !== "none") {
				propagatedFetchSite = propagated;
			}
		}

		location.searchParams.set(QP.referrerSource, referer ?? "");
		if (crossSiteRedirect) location.searchParams.set(QP.crossSiteRedirect, "1");
		if (propagatedFetchSite)
			location.searchParams.set(QP.fetchSite, propagatedFetchSite);
		if (initiatorOriginUrl)
			location.searchParams.set(QP.initiatorOrigin, initiatorOriginUrl.origin);
		if (parsed.isModule) location.searchParams.set(QP.isModule, "module");

		responseHeaders.set("location", sealRoute(location));
	}

	if (response.body && !isRedirect(response)) {
		responseBody = await rewriteBody(handler, request, parsed, response, () =>
			doNetworkFetch(handler, request, parsed, newheaders, false)
		);

		normalizeContentType(parsed, responseHeaders);
	}

	const respcontext: typeof handler.hooks.fetch.response.context = {
		request,
		parsed,
	};
	const respprops: typeof handler.hooks.fetch.response.props = {
		response: {
			body: responseBody,
			headers: responseHeaders,
			status: response.status,
			statusText: response.statusText,
		},
	};

	await Tap.dispatch(handler.hooks.fetch.response, respcontext, respprops);

	return respprops.response;
}

export async function doNetworkFetch(
	handler: FolioFetchHandler,
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	newheaders: FolioHeaders,
	serverRewrite = true
): Promise<BareResponse> {
	const intent = serverRewrite
		? serverRewriteIntent(handler, parsed, request.method)
		: null;
	const init = {
		body: request.body,
		headers: intent
			? [...newheaders.toRawHeaders(), [SERVER_REWRITE_INTENT_HEADER, intent]]
			: newheaders.toRawHeaders(),
		method: request.method,
		redirect: "manual",
	} as BareRequestInit;

	const reqcontext: typeof handler.hooks.fetch.request.context = {
		client: handler.client,
		request,
		parsed,
	};
	const reqprops: typeof handler.hooks.fetch.request.props = {
		init,
		url: parsed.url,
	};
	await Tap.dispatch(handler.hooks.fetch.request, reqcontext, reqprops, true);
	let earlyResponse: BareResponse;

	if (reqprops.earlyResponse) {
		const resp = reqprops.earlyResponse;
		if ("rawHeaders" in resp) {
			earlyResponse = resp;
		} else {
			earlyResponse = BareResponse.fromNativeResponse(resp);
		}
	} else {
		if (request.signal) {
			const transport = handler.client.transport;
			if (!transport.ready) await transport.init();
			const transferred = await transport.request(
				reqprops.url,
				reqprops.init.method ?? "GET",
				reqprops.init.body ?? null,
				reqprops.init.headers ?? [],
				request.signal
			);
			earlyResponse = BareResponse.fromTransferrableResponse(
				transferred,
				reqprops.url.href
			);
		} else {
			earlyResponse = await handler.client.fetch(reqprops.url, reqprops.init);
		}
	}

	const prerespcontext: typeof handler.hooks.fetch.preresponse.context = {
		request,
		parsed,
	};

	const prerespprops: typeof handler.hooks.fetch.preresponse.props = {
		response: earlyResponse,
	};

	await Tap.dispatch(
		handler.hooks.fetch.preresponse,
		prerespcontext,
		prerespprops,
		true
	);

	logFailedNonGetRequest(request, parsed, newheaders, prerespprops.response);

	return prerespprops.response;
}

function bodySize(body: BodyType | null): number | "stream" | "unknown" | null {
	if (body === null) return null;
	if (typeof body === "string") return body.length;
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
		return "stream";
	}
	return "unknown";
}

function logFailedNonGetRequest(
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	headers: FolioHeaders,
	response: BareResponse
) {
	if (request.method === "GET" || request.method === "HEAD") return;
	if (response.status < 400) return;

	console.warn("[folio] non-GET request failed", {
		status: response.status,
		statusText: response.statusText,
		method: request.method,
		url: parsed.url.href,
		bodySize: bodySize(request.body),
		contentType: headers.get("content-type"),
		origin: headers.get("origin"),
		referer: headers.get("referer"),
		secFetchSite: headers.get("sec-fetch-site"),
		secFetchMode: headers.get("sec-fetch-mode"),
		secFetchDest: headers.get("sec-fetch-dest"),
		hasCookie: headers.has("cookie"),
	});
}

function isBlobOrDataUrl(url: _URL): boolean {
	return url.protocol === "blob:" || url.protocol === "data:";
}

async function handleBlobOrDataUrlFetch(
	handler: FolioFetchHandler,
	request: FolioFetchRequest,
	parsed: FolioFetchParsed
): Promise<FolioFetchResponse> {
	let dataUrl = request.rawUrl.pathname.substring(
		handler.context.prefix.pathname.length
	);
	let response: BareResponse;

	if (dataUrl.startsWith("blob:")) {
		dataUrl = unrewriteBlob(dataUrl, handler.context, parsed.meta);
		response = BareResponse.fromNativeResponse(
			await handler.fetchBlobUrl(dataUrl)
		);
	} else {
		response = BareResponse.fromNativeResponse(
			await handler.fetchDataUrl(dataUrl)
		);
	}

	let body: BodyType;
	if (response.body) {
		body = await rewriteBody(
			handler,
			request,
			parsed,
			response as BareResponse
		);
	}
	const headers = FolioHeaders.fromRawHeaders(response.rawHeaders);

	normalizeContentType(parsed, headers);

	if (handler.crossOriginIsolated) {
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	}

	if (parsed.isFakeDataURL) URL.revokeObjectURL(dataUrl);

	return {
		body,
		status: response.status,
		statusText: response.statusText,
		headers: headers,
	};
}

export function registrableDomainForRedirect(hostname: string): string {
	return registrableDomain(hostname);
}

async function handleCookies(
	handler: FolioFetchHandler,
	request: FolioFetchRequest,
	parsed: FolioFetchParsed,
	rawHeaders: RawHeaders
) {
	const cookies = [];

	for (const [key, value] of rawHeaders) {
		if (key.toLowerCase() !== "set-cookie") continue;

		handler.context.cookieJar.setCookies(value, parsed.url);
		cookies.push({
			url: parsed.url,
			cookie: value,
		});
	}

	if (cookies.length === 0) {
		return;
	}

	await handler.sendSetCookie(cookies, {
		destination: parsed.destination,
	});
}
