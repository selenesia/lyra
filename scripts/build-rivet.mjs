import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NEGATIVE = "... /ᐠ - ˕ -マ";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rivetRoot = path.join(root, "packages", "rivet");
const routerOut = path.join(root, "public", "b", "rv");
const extensionOut = path.join(root, "public", "b", "rivet");
const ublockOriginSource = path.join(rivetRoot, "extensions", "ublock.crx");
const ublockOriginStateSource = path.join(rivetRoot, "extensions", "ublock.state.gz");

async function buildRouterScript(entry, naming, label) {
  const result = await Bun.build({
    entrypoints: [path.join(rivetRoot, "src", ...entry)],
    outdir: routerOut,
    naming,
    target: "browser",
    format: "iife",
    minify: true,
    deprecatedNamespaceObjectSetters: false,
  });
  if (!result.success) {
    console.error(`rivet ${label} build failed:`, result.logs, NEGATIVE);
    throw new Error(`rivet ${label} build failed${NEGATIVE}`);
  }
}

async function buildRouter() {
  await rm(routerOut, { recursive: true, force: true });
  await mkdir(routerOut, { recursive: true });
  await buildRouterScript(["router", "swEntry.ts"], "router.js", "router");
  await buildRouterScript(
    ["isolatedBackground", "frame.ts"],
    "background.js",
    "isolated background",
  );
}

async function buildUblockOrigin() {
  await rm(extensionOut, { recursive: true, force: true });
  await mkdir(extensionOut, { recursive: true });
  await copyFile(ublockOriginSource, path.join(extensionOut, "ublock.crx"));
  if (existsSync(ublockOriginStateSource))
    await copyFile(ublockOriginStateSource, path.join(extensionOut, "ublock.state.gz"));
}

await buildRouter();
await buildUblockOrigin();
