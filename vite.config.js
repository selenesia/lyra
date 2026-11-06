import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import lyraPlugin from "./build.js";
import { createSourceBuildId } from "./build-id.mjs";
import { promptStaticBackends } from "./scripts/static-config.mjs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";
import JSZip from "jszip";
import { crxToZip } from "./packages/rivet/src/crx.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const OPAQUE_MODULE_ID = "@serenity-kit/opaque/esm/index.js";
const OPAQUE_WASM_PATTERN =
  /function wasmData\(imports\)\{return _loadWasmModule\(0, null, '([A-Za-z0-9+/=]+)'(?:, imports)?\)\}/;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

export function externalizeOpaqueWasm(code, emitWasm) {
  const match = OPAQUE_WASM_PATTERN.exec(code);
  if (!match) {
    throw new Error("opaque wasm payload was not found; check the opaque package version... /ᐠ - ˕ -マ");
  }
  const wasm = Buffer.from(match[1], "base64");
  if (!WASM_MAGIC.every((byte, index) => wasm[index] === byte)) {
    throw new Error("opaque wasm payload is not valid wasm... /ᐠ - ˕ -マ");
  }
  const reference = emitWasm(wasm);
  const rewritten =
    code.slice(0, match.index) +
    `function wasmData(imports){return fetch(import.meta.ROLLUP_FILE_URL_${reference}).then(r=>r.arrayBuffer()).then(b=>WebAssembly.compile(b))}` +
    code.slice(match.index + match[0].length);
  if (OPAQUE_WASM_PATTERN.test(rewritten) || rewritten.includes("AGFzbQ")) {
    throw new Error("opaque wasm payload is still inlined... /ᐠ - ˕ -マ");
  }
  return rewritten;
}

function opaqueWasmAsset() {
  return {
    name: "opaque-wasm-asset",
    apply: "build",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(OPAQUE_MODULE_ID)) return null;
      return {
        code: externalizeOpaqueWasm(code, (source) =>
          this.emitFile({ type: "asset", name: "opaque.wasm", source }),
        ),
        map: null,
      };
    },
  };
}

async function readExtensionVersion(crxPath) {
  try {
    const archive = await JSZip.loadAsync(crxToZip(new Uint8Array(await readFile(crxPath)).buffer));
    const { version } = JSON.parse(await archive.file("manifest.json").async("text"));
    if (typeof version === "string" && version) return version;
  } catch {}
  throw new Error("bundled extension version could not be read... /ᐠ - ˕ -マ");
}

export default defineConfig(async ({ command, mode }) => {
const staticMode = mode === "static";
const staticBase = staticMode ? process.env.LYRA_STATIC_BASE || "/" : "";
if (staticMode && !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(staticBase)) {
  throw new Error("invalid static deployment path... /ᐠ - ˕ -マ");
}
const staticBackends = staticMode ? await promptStaticBackends(process.env.LYRA_STATIC_BACKEND) : [];
const buildId = createSourceBuildId(
  __dirname,
  staticMode ? `static-v1:${staticBase}:${staticBackends.join(",")}` : process.env.LYRA_WISP_PATH || "",
);
const assetPath = `assets/${buildId}/[hash:12]`;
const ublockVersion = await readExtensionVersion(resolve(__dirname, "packages/rivet/extensions/ublock.crx"));

return {
  plugins: [preact(), opaqueWasmAsset(), lyraPlugin(buildId, undefined, { staticBase, staticBackends })],
  base: command === "build" ? "./" : staticBase || "/",
  define: { __LYRA_STATIC_BASE__: JSON.stringify(staticBase), __LYRA_STATIC_BACKEND__: JSON.stringify(staticBackends[0] || ""), __LYRA_UBLOCK_VERSION__: JSON.stringify(ublockVersion) },
  root: "src",
  publicDir: false,
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
  worker: {
    rolldownOptions: {
      output: {
        entryFileNames: `${assetPath}.js`,
        chunkFileNames: `${assetPath}.js`,
      },
    },
  },
  build: {
    outDir: staticMode ? "../dist-static" : "../dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 550,
    target: "baseline-widely-available",
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true, passes: 2 },
      mangle: true,
    },
    cssMinify: "lightningcss",
    assetsInlineLimit: 8192,
    rolldownOptions: {
      checks: { pluginTimings: false },
      input: {
        main: resolve(__dirname, "src/index.html"),
        404: resolve(__dirname, "src/404.html"),
        player: resolve(__dirname, "src/player.html"),
      },
      output: {
        entryFileNames: `${assetPath}.js`,
        chunkFileNames: `${assetPath}.js`,
        assetFileNames: `${assetPath}[extname]`,
        minifyInternalExports: true,
        manualChunks(id) {
          if (id.includes("components/icons/paths")) return "paths";
          if (id.includes("node_modules/preact")) return "preact";
          if (id.includes("node_modules/zustand")) return "zustand";
          if (id.includes("node_modules/hls.js")) return "hls";
          if (id.includes("node_modules/jszip")) return "extension-vendor";
          if (id.includes("node_modules/@mercuryworkshop")) {
            return "proxy-vendor";
          }
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
      generateScopedName: "x_[hash:base64:10]",
    },
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
};
});
