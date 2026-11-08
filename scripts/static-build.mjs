import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staticBackends } from "./static-config.mjs";

const root = fileURLToPath(new URL("../dist-static/", import.meta.url));
const negative = "... /ᐠ - ˕ -マ";
const fail = () => { throw new Error(`static deployment validation failed${negative}`); };
const allowed = new Set([".html", ".js", ".mjs", ".css", ".json", ".wasm", ".crx", ".svg", ".png", ".jpg", ".jpeg", ".ico", ".avif", ".webp", ".gif", ".woff", ".woff2", ".ttf", ".otf"]);
const metadata = JSON.parse(await readFile(path.join(root, "build-meta.json"), "utf8"));
const backends = staticBackends((metadata.backends || [metadata.backend]).join(","));
if (metadata.protocol !== 2 || !/^[a-f0-9]{12}$/.test(metadata.build) ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(metadata.base)) fail();
const files = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) fail();
    if (entry.isDirectory()) { await inspect(file); continue; }
    if (entry.name !== "_headers" && !allowed.has(path.extname(file))) fail();
    files.push(file);
    if (/\.(?:js|mjs|css|html)$/.test(file) && /sourceMappingURL\s*=/.test(await readFile(file, "utf8"))) fail();
  }
}
await inspect(root);
for (const page of ["index.html", "player.html"]) {
  const html = await readFile(path.join(root, page), "utf8");
  for (const match of html.replace(/<base\b[^>]*>/gi, "").matchAll(/(?:src|href)="((?:\.\/|\/)[^"?#]+)"/g)) {
    const resource = match[1];
    if (resource.startsWith("/!!/")) continue;
    if (!resource.startsWith("./") && !resource.startsWith(metadata.base)) fail();
    if (!(await stat(path.join(root, resource.slice(resource.startsWith("./") ? 2 : metadata.base.length)))).isFile()) fail();
  }
}
if (!files.some((file) => /^[a-f0-9]{10}\.js$/.test(path.relative(root, file)))) fail();
console.log(`static deployment files verified!! (˵◝ ⩊  ◜˵マ`);
console.log(`static protocol: ${metadata.protocol}`);
console.log(`static base: ${metadata.base}`);
let available = process.env.LYRA_STATIC_OFFLINE !== "1";
if (available) for (const backend of backends) {
  try {
    const response = await fetch(backend + "/api/static/v1/status", { signal: AbortSignal.timeout(5_000), redirect: "error" });
    const status = response.ok ? await response.json() : null;
    if (status?.protocol !== metadata.protocol || !status.enabled) available = false;
  } catch { available = false; }
}
if (available) console.log("production static protocol is available!! (˵◝ ⩊  ◜˵マ");
if (!available) {
  if (process.env.LYRA_STATIC_OFFLINE !== "1") throw new Error(`backend static support is unavailable; deploy it before building for upload${negative}`);
  console.warn(`offline static build; backend compatibility is unverified${negative}`);
}
