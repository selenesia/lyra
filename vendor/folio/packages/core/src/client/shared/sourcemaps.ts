import {
	Object_defineProperty,
	Number_isSafeInteger,
	Error,
	Array_isArray,
} from "@/shared/snapshot";
import { base64ToBytes } from "@/shared/util";
import { ProxyCtx, FolioClient } from "@client/index";

enum RewriteType {
	Insert = 0,
	Replace = 1,
}

type Rewrite = {
	start: number;
} & (
	| {
			type: RewriteType.Insert;
			size: number;
	  }
	| {
			type: RewriteType.Replace;
			end: number;
			str: string;
	  }
);

// rewritten scripts push their maps as base64; they are only decoded when
// Function.prototype.toString first needs that tag.
type SourceMapPayload = string | Uint8Array;
export type SourceMaps = Record<string, Rewrite[] | SourceMapPayload>;

function getEnd(rewrite: Rewrite): number {
	if (rewrite.type === RewriteType.Insert) {
		return rewrite.start + rewrite.size;
	} else if (rewrite.type === RewriteType.Replace) {
		return rewrite.end;
	}
	throw "unreachable";
}

function getRewrites(client: FolioClient, tag: string): Rewrite[] | undefined {
	const entry = client.box.sourcemaps[tag];
	if (entry === undefined || Array_isArray(entry)) return entry as Rewrite[] | undefined;
	const rewrites = parseRewrites(
		typeof entry === "string" ? base64ToBytes(entry) : entry
	);
	client.box.sourcemaps[tag] = rewrites;
	return rewrites;
}

function parseRewrites(sourcemap: Uint8Array): Rewrite[] {
	const decoder = new TextDecoder("utf-8");
	const rewrites: Rewrite[] = [];
	let cursor = 0;
	const readVarint = () => {
		let value = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = sourcemap[cursor++];
			value += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		return value;
	};

	const rewritelen = readVarint();
	let mappedEnd = 0;
	for (let i = 0; i < rewritelen; i++) {
		const start = mappedEnd + readVarint();
		const packed = readVarint();
		const size = packed >>> 1;
		mappedEnd = start + size;

		if ((packed & 1) === RewriteType.Insert) {
			rewrites.push({ type: RewriteType.Insert, start, size });
		} else {
			const oldLen = readVarint();
			const oldStr = decoder.decode(
				sourcemap.subarray(cursor, cursor + oldLen)
			);
			rewrites.push({ type: RewriteType.Replace, start, end: mappedEnd, str: oldStr });
			cursor += oldLen;
		}
	}

	return rewrites;
}

const SCRAMTAG = "/*scramtag ";

function extractTag(fn: string): [string, number, number] | null {
	const start = fn.indexOf(SCRAMTAG);
	if (start === -1) return null;

	const end = fn.indexOf("*/", start);
	if (end === -1) {
		dbg.error("unreachable", fn, start, end);
		throw new Error("unreachable");
	}

	const tag = fn.substring(start + 2, end).split(" ");

	if (
		tag.length !== 3 ||
		tag[0] !== "scramtag" ||
		!Number_isSafeInteger(+tag[1])
	) {
		dbg.error("invalid tag", fn, start, end, tag);
		throw new Error("invalid tag");
	}

	return [tag[2], start, +tag[1]];
}

function doUnrewrite(
	client: FolioClient,
	ctx: ProxyCtx<"Function.prototype.toString", "apply">
) {
	const stringified: string = ctx.fn.call(ctx.this);

	const extracted = extractTag(stringified);
	if (!extracted) return ctx.return(stringified);
	const [tag, tagOffset, tagStart] = extracted;

	const fnStart = tagStart - tagOffset;
	const fnEnd = fnStart + stringified.length;
	const rewrites = getRewrites(client, tag);

	if (!rewrites) {
		dbg.warn("failed to get rewrites for tag", tag);

		return ctx.return(stringified);
	}

	let i = 0;
	while (i < rewrites.length) {
		if (rewrites[i].start < fnStart) i++;
		else break;
	}

	let end = i;
	while (end < rewrites.length) {
		if (getEnd(rewrites[end]) < fnEnd) end++;
		else break;
	}
	const fnrewrites = rewrites.slice(i, end);

	let newString = "";
	let lastpos = 0;

	for (const rewrite of fnrewrites) {
		newString += stringified.slice(lastpos, rewrite.start - fnStart);

		if (rewrite.type === RewriteType.Insert) {
			lastpos = rewrite.start + rewrite.size - fnStart;
		} else if (rewrite.type === RewriteType.Replace) {
			newString += rewrite.str;
			lastpos = rewrite.end - fnStart;
		} else {
			throw "unreachable";
		}
	}

	newString += stringified.slice(lastpos);
	newString = newString.replace(`${SCRAMTAG}${tagStart} ${tag}*/`, "");

	return ctx.return(newString);
}

export const enabled = (client: FolioClient) =>
	client.flagEnabled("sourcemaps");

export default function (client: FolioClient, self: Self) {
	Object_defineProperty(self, client.config.globals.pushsourcemapfn, {
		value: (buf: string | ArrayLike<number>, tag: string) => {
			client.box.sourcemaps[tag] =
				typeof buf === "string" ? buf : Uint8Array.from(buf);
			// if (client.flagEnabled("rewriterLogs")) {
			// 	dbg.time(client.meta, before, `scramtag parse for ${tag}`);
			// }
		},
		enumerable: false,
		writable: false,
		configurable: false,
	});

	client.Proxy("Function.prototype.toString", {
		apply(ctx) {
			if (client.box.unproxy.has(ctx.this)) {
				ctx.this = client.box.unproxy.get(ctx.this)!;
				return;
			}
			doUnrewrite(client, ctx);
			// dbg.time(client.meta, before, `scramtag unrewrite for ${ctx.fn.name}`);
		},
	});
}
