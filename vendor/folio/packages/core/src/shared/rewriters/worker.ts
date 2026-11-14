import { flagEnabled, FolioContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { URLMeta } from "@rewriters/url";
import { TextDecoder_decode, TextEncoder_encode } from "@/shared/snapshot";
import { base64Encode, bytesToBase64 } from "@/shared/util";

export function rewriteWorkers(
	js: string | Uint8Array,
	url: string,
	context: FolioContext,
	meta: URLMeta,
	isModule: boolean,
	prerewritten = false
) {
	const script = (script: string) => {
		if (isModule) {
			return `import "${script}"\n`;
		}
		return `importScripts("${script}");\n`;
	};
	const dataPrefix = "data:text/javascript;charset=utf-8;base64,";
	let str = context.interface.getWorkerInjectScripts(meta, isModule, script);

	const encapsulate = flagEnabled("encapsulateWorkers", context, meta.origin);
	if (prerewritten && encapsulate && js instanceof Uint8Array) {
		const bytes = js[0] === 0xef && js[1] === 0xbb && js[2] === 0xbf
			? js.subarray(3) : js;
		const aligned = bytes.length - bytes.length % 3;
		const suffix = TextEncoder_encode(`//# sourceURL=${url}`);
		const tail = new Uint8Array(bytes.length - aligned + suffix.length);
		tail.set(bytes.subarray(aligned));
		tail.set(suffix, bytes.length - aligned);
		return str + script(dataPrefix + bytesToBase64(bytes.subarray(0, aligned)) + bytesToBase64(tail));
	}
	let rewritten = prerewritten
		? js
		: rewriteJs(js, url, context, meta, isModule);
	if (typeof rewritten !== "string") {
		rewritten = TextDecoder_decode(rewritten);
	}

	if (encapsulate) {
		rewritten += `//# sourceURL=${url}`;
		str += script(dataPrefix + base64Encode(rewritten as string));
	} else {
		str += rewritten;
	}
	return str;
}
