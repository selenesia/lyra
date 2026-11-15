import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

declare const FOLIO_ROUTE_KEY: number[];

const key = new Uint8Array(FOLIO_ROUTE_KEY);
const NativeURL = globalThis.URL;
const encodeText = new TextEncoder().encode.bind(new TextEncoder());
const decodeText = new TextDecoder("utf-8", { fatal: true }).decode.bind(new TextDecoder("utf-8", { fatal: true }));
const random = crypto.getRandomValues.bind(crypto);
const encodeBase64 = globalThis.btoa.bind(globalThis);
const decodeBase64 = globalThis.atob.bind(globalThis);
// tokens are opened on every routed request and proxied url getter, so both
// directions are cached; oversized data routes stay uncached.
const sealedTokens = new Map<string, string>();
const openedTokens = new Map<string, string>();
const MAX_CACHE = 4096;
const MAX_CACHED_PLAIN = 16 * 1024;
const MAX_TOKEN = 2 * 1024 * 1024;

function remember(plain: string, token: string): string {
	if (plain.length > MAX_CACHED_PLAIN) return token;
	if (sealedTokens.size >= MAX_CACHE) sealedTokens.delete(sealedTokens.keys().next().value!);
	if (openedTokens.size >= MAX_CACHE) openedTokens.delete(openedTokens.keys().next().value!);
	sealedTokens.set(plain, token);
	openedTokens.set(token, plain);
	return token;
}

export function encodeRouteToken(plain: string): string {
	const cached = sealedTokens.get(plain);
	if (cached) return cached;
	const nonce = random(new Uint8Array(24));
	const encrypted = xchacha20poly1305(key, nonce).encrypt(encodeText(plain));
	const bytes = new Uint8Array(nonce.length + encrypted.length);
	bytes.set(nonce);
	bytes.set(encrypted, nonce.length);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return remember(plain, encodeBase64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

export function decodeRouteToken(token: string): string {
	const cached = openedTokens.get(token);
	if (cached !== undefined) return cached;
	try {
		if (token.length < 54 || token.length > MAX_TOKEN || !/^[\w-]+$/.test(token)) throw 0;
		const binary: string = decodeBase64(token.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const plain = decodeText(xchacha20poly1305(key, bytes.subarray(0, 24)).decrypt(bytes.subarray(24)));
		remember(plain, token);
		return plain;
	} catch {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
}

export function sealRoute(input: string | URL): string {
	const url = new NativeURL(String(input));
	const route = url.pathname.match(/^(.*\/f)\/[a-z0-9]+\/[a-z0-9]+\//);
	if (!route) return url.href;
	const hash = url.hash;
	url.hash = "";
	const token = encodeRouteToken(url.pathname + url.search);
	return url.origin + route[1] + "?s=" + token + (hash ? "#" + encodeRouteToken(hash.slice(1)) : "");
}

export function sealRoutePrefix(input: string | URL): string {
	const url = new NativeURL(String(input));
	const route = url.pathname.match(/^(.*\/f)\/[a-z0-9]+\/[a-z0-9]+\//);
	if (!route || url.hash) return url.href;
	return url.origin + route[1] + "/~" + encodeRouteToken(url.pathname + url.search) + "/";
}

function openRoutePrefix(url: URL, route: string, token: string, rest: string): URL {
	const sealed = decodeRouteToken(token);
	const query = sealed.indexOf("?");
	const path = query === -1 ? sealed : sealed.slice(0, query);
	if (!path.startsWith(route + "/") || !/^[a-z0-9]+\/[a-z0-9]+\//.test(path.slice(route.length + 1))) {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
	const internal = new NativeURL(
		path + encodeURIComponent(rest + url.search) + (query === -1 ? "" : sealed.slice(query)),
		url.origin
	);
	internal.hash = url.hash;
	return internal;
}

export function openRoute(input: string | URL): URL {
	const url = new NativeURL(String(input));
	const prefixed = url.pathname.match(/^(.*\/f)\/~([\w-]+)\/(.*)$/s);
	if (prefixed) return openRoutePrefix(url, prefixed[1], prefixed[2], prefixed[3]);
	if (!url.pathname.endsWith("/f")) return url;
	const token = url.searchParams.get("s");
	if (!token || [...url.searchParams.keys()].some((key) => key !== "s") || url.searchParams.getAll("s").length !== 1) {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
	const path = decodeRouteToken(token);
	if (!path.startsWith(url.pathname + "/") || !/^[a-z0-9]+\/[a-z0-9]+\//.test(path.slice(url.pathname.length + 1))) {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
	const internal = new NativeURL(path, url.origin);
	if (url.hash) internal.hash = decodeRouteToken(url.hash.slice(1));
	return internal;
}

export function routeDestination(input: string | URL): string | null {
	const url = new NativeURL(String(input));
	if (!url.pathname.endsWith("/f")) return null;
	const internal = openRoute(url);
	const path = internal.pathname.slice(url.pathname.length + 1).replace(/^[a-z0-9]+\/[a-z0-9]+\//, "");
	if (path.startsWith("blob:") || path.startsWith("data:")) return path + internal.search + internal.hash;
	const destination = decodeURIComponent(path);
	if (!/^https?:\/\//.test(destination)) return null;
	return destination + (internal.hash ? "#" + decodeURIComponent(internal.hash.slice(1)) : "");
}
