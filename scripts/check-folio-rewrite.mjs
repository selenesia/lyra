import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const core = path.join(root, "vendor/folio/packages/core");
const { folioRewriterHash } = await import(path.join(root, "vendor/folio/rewriter-hash.mjs"));

Object.assign(globalThis, {
  FOLIO_ROUTE_KEY: Array.from({ length: 32 }, (_, index) => index),
  FOLIO_REWRITER_HASH: folioRewriterHash(path.join(core, "rewriter")),
  VERSION: "check",
  COMMITHASH: "check",
  BUILDDATE: "check",
  REWRITERWASM: undefined,
  dbg: { warn() {}, error() {}, log() {}, time() {} },
});

const { defaultConfig } = await import(path.join(core, "src/index.ts"));
const { setWasm } = await import(path.join(core, "src/shared/rewriters/wasm.ts"));
const { rewriteJs } = await import(path.join(core, "src/shared/rewriters/js.ts"));
const { applyImportUrls, sealedUrlModel } = await import(path.join(core, "src/fetch/serverRewrite.ts"));

setWasm(new Uint8Array(readFileSync(path.join(core, "dist/folio.wasm"))));

const context = {
  prefix: new URL("https://lyra.example/f/abc12345/def67890/"),
  config: { ...defaultConfig, flags: { ...defaultConfig.flags, allowInvalidJs: false } },
  interface: {
    codecEncode: (value) => (value ? encodeURIComponent(value) : value),
    codecDecode: (value) => (value ? decodeURIComponent(value) : value),
  },
};

function largestScript(directory) {
  if (!existsSync(directory)) return null;
  let largest = null;
  for (const entry of readdirSync(directory, { recursive: true })) {
    const file = path.join(directory, String(entry));
    if (!file.endsWith(".js")) continue;
    const size = statSync(file).size;
    if (!largest || size > largest.size) largest = { file, size };
  }
  return largest?.file ?? null;
}

const fixtures = [
  {
    name: "inline classic script",
    url: "https://game.example/js/classic.js",
    source: "var { href } = location;\ntop.postMessage(eval('location.href'), '*');\nfunction origin() { return parent.location.origin; }\n",
  },
  {
    name: "inline strict script with a byte order mark",
    url: "https://game.example/js/strict.js",
    source: "﻿ 'use strict';\nfunction where() { return window.location; }\n",
  },
  {
    name: "inline module",
    url: "https://game.example/js/main.js",
    module: true,
    source: [
      'import first, { second } from "./dep.js";',
      "import * as third from '../lib/third.mjs?v=1.2.3#entry';",
      'export * from "https://cdn.example:8443/a%20b/shared.js";',
      'export { fourth } from "/abs/fourth.js";',
      "const lazy = () => import('./lazy.js');",
      "export function where() { return [location.href, import.meta.url, first, second, third, lazy]; }",
      "",
    ].join("\n"),
  },
  {
    name: "inline module without imports",
    url: "https://game.example/js/leaf.js",
    module: true,
    source: "export const where = () => top.location;\n",
  },
];
for (const file of [
  path.join(core, "dist/folio.js"),
  largestScript(path.join(root, "dist/assets")),
]) {
  if (!file || !existsSync(file)) continue;
  fixtures.push({
    name: path.relative(root, file),
    url: `https://game.example/static/${path.basename(file)}`,
    bytes: new Uint8Array(readFileSync(file)),
  });
}

const build = Bun.spawnSync(["cargo", "build", "--quiet"], {
  cwd: path.join(root, "services/mochi"),
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  console.error("mochi could not be built... /ᐠ - ˕ -マ");
  process.exit(1);
}

const worker = Bun.spawn(
  [path.join(root, "target/debug/mochi"), "--folio-rewrite-worker", "0"],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: {} },
);
const replies = worker.stdout.getReader();
let buffered = new Uint8Array(0);

async function readExactly(length) {
  while (buffered.length < length) {
    const { done, value } = await replies.read();
    if (done) throw new Error("rewrite worker closed its output... /ᐠ - ˕ -マ");
    const joined = new Uint8Array(buffered.length + value.length);
    joined.set(buffered);
    joined.set(value, buffered.length);
    buffered = joined;
  }
  const taken = buffered.subarray(0, length);
  buffered = buffered.subarray(length);
  return taken;
}

async function readPart() {
  const header = await readExactly(4);
  return readExactly(new DataView(header.buffer, header.byteOffset, 4).getUint32(0));
}

function writePart(bytes) {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, bytes.length);
  worker.stdin.write(header);
  worker.stdin.write(bytes);
}

async function serverRewrite(fixture, meta) {
  const flags = context.config.flags;
  const job = {
    module: Boolean(fixture.module),
    base: fixture.url,
    flags: {
      sourcemaps: flags.sourcemaps,
      captureErrors: flags.captureErrors,
      scramitize: flags.scramitize,
      disableComputedWrap: flags.disableComputedWrap,
      destructureRewrites: flags.destructureRewrites,
    },
    config: context.config.globals,
    urls: fixture.module ? sealedUrlModel(context, meta) : null,
  };
  writePart(new TextEncoder().encode(JSON.stringify(job)));
  writePart(fixture.bytes);
  await worker.stdin.flush();
  const reply = JSON.parse(new TextDecoder().decode(await readPart()));
  const payload = Uint8Array.from(await readPart());
  if (reply.status !== "rewritten") return null;
  const output = brotliDecompressSync(payload);
  return reply.patched ? applyImportUrls(output, context, meta) : output;
}

function normalized(output) {
  const text = typeof output === "string" ? output : new TextDecoder().decode(output);
  const tag = /\/\*scramtag \d+ ([0-9a-f]{11})\*\//.exec(text)?.[1]
    ?? /", "([0-9a-f]{11})"\);/.exec(text)?.[1];
  return tag ? text.replaceAll(tag, "tag") : text;
}

let failed = false;
for (const fixture of fixtures) {
  fixture.bytes ??= new TextEncoder().encode(fixture.source);
  const url = new URL(fixture.url);
  const meta = { origin: url, base: url };
  const client = normalized(
    rewriteJs(fixture.bytes.slice(), fixture.url, context, meta, Boolean(fixture.module)),
  );
  const served = await serverRewrite(fixture, meta);
  if (served === null || normalized(served) !== client) {
    failed = true;
    console.error(`folio rewrite parity failed for ${fixture.name}... /ᐠ - ˕ -マ`);
  } else {
    console.log(`${fixture.name}: ${fixture.bytes.length} bytes match`);
  }
}

worker.stdin.end();
await worker.exited;
if (failed) process.exit(1);
console.log("folio rewrite parity ok!! (˵◝ ⩊  ◜˵マ");
