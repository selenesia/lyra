import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const crates = ["js", "transform", "coverage-macro"];

function rustSources(root, relative, found) {
	let entries;
	try {
		entries = readdirSync(join(root, relative), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = `${relative}/${entry.name}`;
		if (entry.isDirectory()) rustSources(root, path, found);
		else if (entry.isFile() && entry.name.endsWith(".rs")) found.push(path);
	}
}

export function folioRewriterHash(rewriterDir) {
	const paths = ["Cargo.lock"];
	for (const crate of crates) {
		paths.push(`${crate}/Cargo.toml`);
		rustSources(rewriterDir, `${crate}/src`, paths);
	}
	paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
	const identity = createHash("sha256");
	for (const path of paths) {
		const digest = createHash("sha256")
			.update(readFileSync(join(rewriterDir, path)))
			.digest("hex");
		identity.update(`${path}\n${digest}\n`);
	}
	return identity.digest("hex").slice(0, 16);
}
