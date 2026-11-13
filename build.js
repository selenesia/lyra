import path from "path";
import { cp, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { brotliCompress, constants as zlibConstants, gzip } from "zlib";
import { promisify } from "util";
import { createHash } from "crypto";
import JavaScriptObfuscator from "javascript-obfuscator";
import { createSourceBuildId } from "./build-id.mjs";
import { createDomNames, DOM_NAME_ATTRIBUTES } from "./src/core/ui/domNames.ts";

const { obfuscate } = JavaScriptObfuscator;
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const SENSITIVE_TERM = /(games?|anime|proxy|rivet|folio|lyra)/i;
const SENSITIVE_STRING_PATTERN =
  "[Gg]ames?|[Aa]nime|[Pp]roxy|[Rr]ivet|[Ff]olio|[Ll]yra";
const ZERO_MATCH_TERM = /games?|proxy/gi;
const WASM_PAYLOAD_PATTERN = "(?:data:[\\w/+.-]+;base64,)?AGFzbQ";
const ICON_MARKUP_PATTERN = `^(?![\\s\\S]*(?:${SENSITIVE_STRING_PATTERN}))<(?:svg|path|circle|rect|line|polyline|polygon|ellipse)\\b`;
const WASM_PAYLOAD_LITERAL = new RegExp(
  `(["'])${WASM_PAYLOAD_PATTERN}[\\w+/=]*\\1`,
  "g",
);
const WASM_PAYLOAD_SIGNAL = new RegExp(
  [SENSITIVE_TERM.source, ["wa", "ves"].join(""), ["ma", "ia"].join("")].join(
    "|",
  ),
  "gi",
);

export const FOLIO_RUNTIME_TOKENS = [
  "$folio",
  "$folioController",
  "$folioUtils",
  "$folio$wrap",
  "$folio__",
  "$folio$prop",
  "$folio$clean",
  "$folio$import",
  "$folio$rewrite",
  "$folio$meta",
  "$folio$wrappostmessage",
  "$folio$pushsourcemap",
  "$folio$tryset",
  "$folio$temploc",
  "$folio$tempunused",
  "$folioerr",
  "$folio$setrealmfn",
  "$folio$messagetype",
  "$folio$origin",
  "$folio$data",
  "folio client global",
  "folio realm pollutant",
  "folio original onevent function",
  "controller frame handle",
  "folio-injected",
  "FolioClient",
  "FolioFetchHandler",
  "FolioFetchTrackedClient",
  "FolioHeaders",
  "FOLIOCLIENT",
  "FOLIOCLIENTNAME",
  "assertRuntimeFolioVersion",
  "ManagedPlugin",
  "CatchEscapedLinksPlugin",
  "EventHandlerPlugin",
  "HttpCachePlugin",
  "LinkHandlerPlugin",
  "UrlWatcherPlugin",
];

export function createFolioTokenMap(buildId) {
  return new Map(
    FOLIO_RUNTIME_TOKENS.map((token) => [
      token,
      `x${createHash("sha256").update(`${buildId}\0folio-runtime\0${token}`).digest("hex").slice(0, 20)}`,
    ]),
  );
}

export const APP_RUNTIME_TOKENS = [
  "Lyra",
  "lyraConnection",
  "lyraUpdater",
  "lyraExportAllData",
  "lyraImportDataFromObject",
  "__lyraStuffData",
  "__lyraUpdatePollerStarted",
  "__lyraStreamDiagnostics",
  "__lyraAppInitialized",
  "__lyraAdcashLoading",
  "__LYRA_WEBRTC_TURN__",
  "__lyraInternalHandlers",
  "__lyraTabId",
  "__lyraHistoryManager",
  "__lyraRelay",
  "lyraAppInitialized",
  "lyraUpdateOverlayBound",
  "lyra:stream-diagnostic",
  "lyra:game-metric",
  "lyra:game-catalog-updated",
  "x-lyra-prefetch",
  "lyra-prefetch",
  "lyra-prefetch-bridge",
  "lyra.nuruSocket",
  "lyra.nuruTickets",
  "__LYRA_APP_BASE__",
  "__LYRA_BACKEND__",
  "__LYRA_BACKEND_INDEX__",
  "__LYRA_BACKENDS__",
  "__LYRA_BACKEND_CONTROL__",
  "__LYRA_WORKER_ORIGIN__",
  "__LYRA_WORKER_BASE__",
  "__LYRA_STORAGE_NAMESPACE__",
  "__LYRA_PREPARE_FRAME__",
  "__lyra_backend",
  "lyra.staticWorker",
  "lyra.staticSocket",
];

export function createAppRuntimeTokenMap(buildId) {
  return new Map(
    APP_RUNTIME_TOKENS.map((token) => [
      token,
      `x${createHash("sha256").update(`${buildId}\0app-global\0${token}`).digest("hex").slice(0, 20)}`,
    ]),
  );
}

const OBFUSCATION_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  forceTransformStrings: [
    `^(?!${WASM_PAYLOAD_PATTERN})[\\s\\S]*(?:${SENSITIVE_STRING_PATTERN})`,
  ],
  identifierNamesGenerator: "mangled",
  log: false,
  renameGlobals: true,
  renameVariables: true,
  reservedStrings: [`^${WASM_PAYLOAD_PATTERN}`, ICON_MARKUP_PATTERN],
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 1,
  splitStrings: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

export const RUNTIME_OBFUSCATION_OPTIONS = {
  ...OBFUSCATION_OPTIONS,
  renameGlobals: false,
  renameVariables: false,
};

const RUNTIME_ASSETS = [
  {
    logicalPath: "/bmux/worker.js",
    source: [
      "node_modules",
      "@mercuryworkshop",
      "bare-mux",
      "dist",
      "worker.js",
    ],
  },
  ...["epoxy", "libcurl"].map((transport) => ({
    logicalPath: `/${transport}/index.mjs`,
    source: [
      "node_modules",
      "@mercuryworkshop",
      `${transport}-transport`,
      "dist",
      "index.mjs",
    ],
  })),
  { logicalPath: "/b/fl/folio.js", source: ["public", "b", "fl", "folio.js"] },
  {
    logicalPath: "/b/fl/controller.inject.js",
    source: ["public", "b", "fl", "controller.inject.js"],
  },
  {
    logicalPath: "/b/fl/controller.sw.js",
    source: ["public", "b", "fl", "controller.sw.js"],
  },
  {
    logicalPath: "/b/fl/folio.wasm",
    source: ["public", "b", "fl", "folio.wasm"],
  },
  {
    logicalPath: "/b/rv/router.js",
    source: ["public", "b", "rv", "router.js"],
  },
  {
    logicalPath: "/b/rv/background.js",
    source: ["public", "b", "rv", "background.js"],
  },
  {
    logicalPath: "/b/rivet/ublock.crx",
    source: ["packages", "rivet", "extensions", "ublock.crx"],
  },
  {
    logicalPath: "/b/rivet/ublock.state.gz",
    source: ["packages", "rivet", "extensions", "ublock.state.gz"],
  },
  {
    logicalPath: "/b/rivet/ublock.firefox.state.gz",
    source: ["packages", "rivet", "extensions", "ublock.firefox.state.gz"],
  },
];

const SW_MODULES = [
  "constants.js",
  "state.js",
  "init.js",
  "utils.js",
  "decode.js",
  "inject.js",
  "network.js",
  "messaging.js",
  "handler.js",
];

function stripSourceMapComments(source) {
  return source
    .replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, "")
    .replace(/\/\*[#@]\s*sourceMappingURL=.*?\*\//gs, "");
}

function escapeSecondCharacter(match) {
  const escapedCharacter = match.charCodeAt(1).toString(16).padStart(4, "0");
  return `${match[0]}\\u${escapedCharacter}${match.slice(2)}`;
}

function encodeBuildLexemes(source) {
  return source.replace(ZERO_MATCH_TERM, escapeSecondCharacter);
}

function encodeWasmPayloadLexemes(source) {
  return source.replace(WASM_PAYLOAD_LITERAL, (literal) =>
    literal.replace(WASM_PAYLOAD_SIGNAL, escapeSecondCharacter),
  );
}

function compatibleRegexSource(source) {
  return source.replaceAll("(?i:url)", "[uU][rR][lL]");
}

function encodeLibrarySource(source) {
  return encodeBuildLexemes(
    encodeWasmPayloadLexemes(compatibleRegexSource(source)),
  );
}

export function obfuscateSource(source, options, identifiersPrefix) {
  return encodeBuildLexemes(
    encodeWasmPayloadLexemes(
      obfuscate(compatibleRegexSource(source), {
        ...options,
        seed: identifiersPrefix || "lyra-build",
        ...(identifiersPrefix ? { identifiersPrefix } : {}),
      }).getObfuscatedCode(),
    ),
  );
}

function obfuscationPrefix(buildId, scope) {
  return `x${createHash("sha256")
    .update(`${buildId}\0${scope}\0obfuscation`)
    .digest("hex")
    .slice(0, 10)}`;
}

function inlineStyleScript(css) {
  return `<script>(function(){const style=document.createElement("style");style.textContent=${JSON.stringify(css)};document.currentScript.replaceWith(style);})();</script>`;
}

export function obfuscateInlinePageCode(html, buildId, pageName) {
  let scriptIndex = 0;
  return html
    .replace(/<style>([\s\S]*?)<\/style>/g, (_match, css) => inlineStyleScript(css))
    .replace(/<script>([\s\S]*?)<\/script>/g, (_match, source) => {
      const obfuscated = obfuscateSource(
        source,
        OBFUSCATION_OPTIONS,
        obfuscationPrefix(buildId, `${pageName}#${scriptIndex++}`),
      );
      return `<script>${obfuscated.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
    });
}

function opaqueFileName(logicalPath, buildId) {
  const extension = path.extname(logicalPath);
  const hash = createHash("sha256")
    .update(`${buildId}\0${logicalPath}`)
    .digest("hex")
    .slice(0, 12);
  return `b/${hash}${extension}`;
}

export function createRuntimePathMap(buildId) {
  return Object.fromEntries(
    RUNTIME_ASSETS.map(({ logicalPath }) => [
      logicalPath,
      `/${opaqueFileName(logicalPath, buildId)}`,
    ]),
  );
}

function addSensitiveToken(tokens, token) {
  if (SENSITIVE_TERM.test(token)) tokens.add(token);
}

const DOM_NAME_CALLS = new Map([
  ["getElementById", [[0, "list"]]],
  ["getElementsByClassName", [[0, "list"]]],
  ["querySelector", [[0, "selector"]]],
  ["querySelectorAll", [[0, "selector"]]],
  ["closest", [[0, "selector"]]],
  ["matches", [[0, "selector"]]],
  ["insertAdjacentHTML", [[1, "markup"]]],
]);
const CLASS_LIST_CALLS = new Map([
  ["add", "all"],
  ["remove", "all"],
  ["toggle", [0]],
  ["contains", [0]],
  ["replace", [0, 1]],
]);
const DOM_NAME_PROPERTIES = new Map([
  ["className", "list"],
  ["id", "list"],
  ["innerHTML", "markup"],
  ["outerHTML", "markup"],
]);
const DOM_NAME_ASSIGNMENTS = new Set(["=", "+=", "||=", "&&=", "??="]);
const DOM_NAME_HELPERS = {
  list: ["mapDomNames", "__mapDomNames"],
  selector: ["mapDomSelector", "__mapDomSelector"],
  markup: ["mapDomMarkup", "__mapDomMarkup"],
};
const DOM_NAME_SITE_HINT =
  /classList|className|\.id\s*=|innerHTML|outerHTML|getElementById|getElementsByClassName|querySelector|closest|matches|setAttribute|insertAdjacentHTML/;
const DOM_NAME_EDIT_ORDER = { close: 0, open: 1, replace: 2 };

function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function memberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return node.computed ? staticString(node.property) : null;
}

function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

function isClassList(node) {
  const target = unwrapExpression(node);
  return (
    (target?.type === "Identifier" && target.name === "classList") ||
    memberName(target) === "classList"
  );
}

function applyDomNameEdits(code, edits) {
  edits.sort(
    (left, right) =>
      left.start - right.start ||
      DOM_NAME_EDIT_ORDER[left.side] - DOM_NAME_EDIT_ORDER[right.side] ||
      (left.side === "close" ? left.span - right.span : right.span - left.span),
  );
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) {
      throw new Error("class and id name rewrites overlap... /ᐠ - ˕ -マ");
    }
    output += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + code.slice(cursor);
}

export function rewriteDomNameSites(code, program, names, helperModule = null) {
  const edits = [];
  const helpers = new Set();

  const wrap = (node, kind, open, close) => {
    if (!helperModule) {
      throw new Error("inline page scripts must use fixed class and id names... /ᐠ - ˕ -マ");
    }
    helpers.add(kind);
    const span = node.end - node.start;
    edits.push({ start: node.start, end: node.start, text: open, side: "open", span });
    edits.push({ start: node.end, end: node.end, text: close, side: "close", span });
  };

  const mapValue = (node, kind) => {
    if (!node) return;
    const helper = DOM_NAME_HELPERS[kind][1];
    if (node.type === "SpreadElement") {
      wrap(node.argument, kind, "Array.from(", `, ${helper})`);
      return;
    }
    const value = staticString(node);
    if (value === null) {
      wrap(node, kind, `${helper}(`, ")");
      return;
    }
    const mapped = names[kind](value);
    if (mapped !== value) {
      edits.push({ start: node.start, end: node.end, text: JSON.stringify(mapped), side: "replace" });
    }
  };

  const inspectCall = (node) => {
    const callee = unwrapExpression(node.callee);
    const method = memberName(callee);
    if (!method) return;
    if (CLASS_LIST_CALLS.has(method) && isClassList(callee.object)) {
      const positions = CLASS_LIST_CALLS.get(method);
      node.arguments.forEach((argument, index) => {
        if (positions === "all" || positions.includes(index)) mapValue(argument, "list");
      });
      return;
    }
    if (method === "setAttribute") {
      const attribute = staticString(node.arguments[0]);
      if (attribute !== null && DOM_NAME_ATTRIBUTES.includes(attribute.toLowerCase())) {
        mapValue(node.arguments[1], "list");
      }
      return;
    }
    for (const [index, kind] of DOM_NAME_CALLS.get(method) ?? []) {
      mapValue(node.arguments[index], kind);
    }
  };

  const inspectAssignment = (node) => {
    const target = unwrapExpression(node.left);
    const property = memberName(target);
    const kind = DOM_NAME_PROPERTIES.get(property);
    if (!kind || !DOM_NAME_ASSIGNMENTS.has(node.operator)) return;
    if (property === "id" && target.object.type === "ThisExpression") return;
    mapValue(node.right, kind);
  };

  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node.type !== "string") return;
    if (node.type === "CallExpression") inspectCall(node);
    else if (node.type === "AssignmentExpression") inspectAssignment(node);
    for (const key in node) {
      const child = node[key];
      if (child && typeof child === "object") visit(child);
    }
  };

  visit(program);
  if (edits.length === 0) return code;
  const output = applyDomNameEdits(code, edits);
  if (helpers.size === 0) return output;
  const imports = [...helpers]
    .map((kind) => `${DOM_NAME_HELPERS[kind][0]} as ${DOM_NAME_HELPERS[kind][1]}`)
    .join(", ");
  return `import { ${imports} } from ${JSON.stringify(helperModule)};\n${output}`;
}

export function renameCssSelector(node, names, seen) {
  if (Array.isArray(node)) return node.map((child) => renameCssSelector(child, names, seen));
  if (!node || typeof node !== "object") return node;
  const renamed = {};
  for (const [key, value] of Object.entries(node)) {
    renamed[key] = renameCssSelector(value, names, seen);
  }
  if ((renamed.type === "class" || renamed.type === "id") && typeof renamed.name === "string") {
    seen.add(renamed.name);
    renamed.name = names.list(renamed.name);
  }
  return renamed;
}

export function rewriteStyleSelectors(css, names) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[{};])([^{};@]+)(?=\{)/g, (_match, boundary, prelude) =>
      boundary + names.selector(prelude),
    );
}

export function rewritePageDomNames(html, names, parse) {
  return names
    .markup(html)
    .replace(/<style>([\s\S]*?)<\/style>/g, (_match, css) =>
      `<style>${rewriteStyleSelectors(css, names)}</style>`,
    )
    .replace(/<script>([\s\S]*?)<\/script>/g, (_match, source) =>
      `<script>${rewriteDomNameSites(source, parse(source), names)}</script>`,
    );
}

function createCssTokenMap(cssSources, salt, selectorNames = []) {
  const tokens = new Set();
  const selectors = new Set();
  for (const name of selectorNames) addSensitiveToken(selectors, name);

  for (const source of cssSources) {
    for (const match of source.matchAll(/([^{}]+)\{/g)) {
      const header = match[1].trim();
      if (header.startsWith("@")) continue;
      for (const selector of header.matchAll(/[.#]([_a-zA-Z][\w-]*)/g)) {
        addSensitiveToken(selectors, selector[1]);
      }
    }

    for (const customProperty of source.matchAll(/--([_a-zA-Z][\w-]*)/g)) {
      addSensitiveToken(tokens, `--${customProperty[1]}`);
    }
    for (const keyframes of source.matchAll(
      /@(?:-webkit-)?keyframes\s+([_a-zA-Z][\w-]*)/g,
    )) {
      addSensitiveToken(tokens, keyframes[1]);
    }
  }

  const domNames = createDomNames(salt);
  return new Map([
    ...[...tokens].map((token) => {
      const hash = createHash("sha256")
        .update(`${salt}\0${token}`)
        .digest("hex")
        .slice(0, 10);
      return [token, token.startsWith("--") ? `--x${hash}` : `x${hash}`];
    }),
    ...[...selectors].map((name) => [name, domNames.list(name)]),
  ]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteBuildTokens(source, tokenMap, pathAliases = new Map()) {
  let rewritten = source;
  for (const [logicalPath, emittedPath] of pathAliases) {
    rewritten = rewritten.split(logicalPath).join(emittedPath);
  }
  for (const [token, replacement] of [...tokenMap].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    rewritten = rewritten.replace(
      new RegExp(
        `(?<![A-Za-z0-9_$-])${escapeRegExp(token)}(?![A-Za-z0-9_$-])`,
        "g",
      ),
      replacement,
    );
  }
  return rewritten;
}

function containsAppCode(chunk, projectRoot) {
  const appRoot = path.join(projectRoot, "src") + path.sep;
  const rivetRoot = path.join(projectRoot, "packages", "rivet") + path.sep;
  return Object.keys(chunk.modules ?? {}).some(
    (moduleId) =>
      moduleId.startsWith(appRoot) || moduleId.startsWith(rivetRoot),
  );
}

export default function lyraPlugin(
  buildId = createSourceBuildId(process.cwd()),
  wispPath = process.env.LYRA_WISP_PATH ?? "/w/",
  { staticBase = "", staticBackends = [] } = {},
) {
  let outputDirectory;
  let serviceWorkerSourceDirectory;
  let projectRoot;
  let appSourceDirectory;
  let pageRuntimeDirectory;
  let domNamesModule;
  let isBuild = false;
  const domNames = createDomNames(buildId);
  const selectorNames = new Set();

  return {
    name: "lyra-build",
    enforce: "post",

    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return staticBase ? html
          .replace('<base href="/" />', `<base href="${staticBase}" />`)
          .replace('/app/entry.tsx', '/static/entry.ts')
          .replace('/app/playerEntry.tsx', '/static/player.ts')
          .replace(/(<link\s+rel="icon"\s+)href="([^"]+)"/i, '$1href="/assets/images/peaks/natsu.png" data-static-icon="$2"')
          .replace(/<head>(?:\s*<base\b[^>]*>)?/i, '$&<script src="/b/static.js"></script>') : html;
      },
    },

    config(_config, { command }) {
      isBuild = command === "build";
      if (isBuild && !/^\/(?:w|[a-f0-9]{64})\/$/.test(wispPath)) {
        throw new Error("invalid wisp endpoint... /ᐠ - ˕ -マ");
      }
      return {
        ...(isBuild
          ? {
              css: {
                lightningcss: {
                  visitor: {
                    Selector: (selector) =>
                      renameCssSelector(selector, domNames, selectorNames),
                  },
                },
              },
            }
          : {}),
        define: {
          __LYRA_WISP_PATH__: JSON.stringify(
            command === "build" ? wispPath : "/w/",
          ),
          __LYRA_BUILD_ID__: JSON.stringify(command === "build" ? buildId : ""),
          __LYRA_RUNTIME_PATHS__: JSON.stringify(
            command === "build"
              ? Object.fromEntries(
                  Object.entries(createRuntimePathMap(buildId)).map(
                    ([key, value]) => [key.slice(1), `.${value}`],
                  ),
                )
              : {},
          ),
        },
      };
    },

    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
      serviceWorkerSourceDirectory = path.join(config.root, "b", "sw");
      projectRoot = path.resolve(config.root, "..");
      appSourceDirectory = path.resolve(config.root) + path.sep;
      pageRuntimeDirectory = path.join(appSourceDirectory, "b") + path.sep;
      domNamesModule = path.join(appSourceDirectory, "core", "ui", "domNames.ts");
    },

    transform(code, id) {
      if (!isBuild || !DOM_NAME_SITE_HINT.test(code)) return null;
      const file = id.split("?")[0];
      if (
        !file.startsWith(appSourceDirectory) ||
        file.startsWith(pageRuntimeDirectory) ||
        file === domNamesModule ||
        !/\.[cm]?[jt]sx?$/.test(file)
      ) {
        return null;
      }
      const rewritten = rewriteDomNameSites(code, this.parse(code), domNames, domNamesModule);
      return rewritten === code ? null : { code: rewritten, map: null };
    },

    async writeBundle(_options, bundle) {
      const precacheAssets = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!fileName.startsWith("assets/")) continue;
        if (
          (chunk.type === "chunk" && fileName.endsWith(".js")) ||
          (chunk.type === "asset" && fileName.endsWith(".css"))
        ) {
          precacheAssets.push((staticBase || "/") + fileName);
        }
      }

      await mkdir(path.join(outputDirectory, "b"), { recursive: true });

      const cssFiles = Object.entries(bundle)
        .filter(
          ([fileName, output]) =>
            output.type === "asset" && fileName.endsWith(".css"),
        )
        .map(([fileName]) => path.join(outputDirectory, fileName));
      const cssSources = await Promise.all(
        cssFiles.map((filePath) => readFile(filePath, "utf8")),
      );
      const cssTokenMap = new Map([
        ...createCssTokenMap(cssSources, buildId, selectorNames),
        ...createFolioTokenMap(buildId),
        ...createAppRuntimeTokenMap(buildId),
        [
          "bare-mux-path",
          `x${createHash("sha256").update(`${buildId}\0bare-mux-path`).digest("hex").slice(0, 20)}`,
        ],
      ]);

      const runtimePaths = createRuntimePathMap(buildId);
      const pathAliases = new Map(
        Object.entries(runtimePaths).map(([key, value]) =>
          [key, staticBase ? staticBase + value.slice(1) : value]),
      );
      const runtimeBundleFileName = opaqueFileName("/b/all.js", buildId);
      pathAliases.set("/b/all.js", `${staticBase || "/"}${runtimeBundleFileName}`);
      if (staticBase && staticBase !== "/") pathAliases.set("/assets/images/", `${staticBase}assets/images/`);

      const socketSource = staticBase
        ? rewriteBuildTokens((await readFile(path.join(projectRoot, "src/static/socket.js"), "utf8"))
          .replaceAll("__STATIC_BASE__", staticBase), cssTokenMap) : "";
      const nuruSocketSource = staticBase ? "" : rewriteBuildTokens(
        (await readFile(path.join(projectRoot, "src/core/proxy/nuruSocket.js"), "utf8")).replace(/^export /m, ""), cssTokenMap);
      let staticPrelude = "";
      if (staticBase) {
        const config = staticBackends.map((origin) => ({ origin,
          namespace: `ls-${createHash("sha256").update(`${staticBase}\0${origin}`).digest("hex").slice(0, 24)}:` }));
        const controlKey = `ls-route-${createHash("sha256").update(`${staticBase}\0${staticBackends.join(",")}`).digest("hex").slice(0, 24)}`;
        const backendSource = await readFile(path.join(projectRoot, "src/static/backend.js"), "utf8");
        const storageSource = await readFile(path.join(projectRoot, "src/static/storage.js"), "utf8");
        const workerSource = (await readFile(path.join(projectRoot, "src/static/workers.js"), "utf8")).replaceAll("__STATIC_BASE__", staticBase);
        staticPrelude = rewriteBuildTokens(`globalThis.__LYRA_APP_BASE__=${JSON.stringify(staticBase)};\n${backendSource}\n${storageSource}\n${workerSource}\ninstallStaticBackend(${JSON.stringify(config)}, ${JSON.stringify(controlKey)});\ninstallStaticStorage(${JSON.stringify(config)}[globalThis.__LYRA_BACKEND_INDEX__].namespace);\ninstallStaticWorkers();\nglobalThis.__LYRA_PREPARE_FRAME__ = (realm) => { realm.__LYRA_APP_BASE__=${JSON.stringify(staticBase)}; realm.__LYRA_BACKEND__=globalThis.__LYRA_BACKEND__; installStaticBackend(${JSON.stringify(config)}, ${JSON.stringify(controlKey)}, realm); installStaticStorage(${JSON.stringify(config)}[globalThis.__LYRA_BACKEND_INDEX__].namespace, realm); installStaticWorkers(realm); };`, cssTokenMap);
        const bootstrapFile = opaqueFileName("/b/static.js", buildId);
        pathAliases.set("/b/static.js", staticBase + bootstrapFile);
        await writeFile(path.join(outputDirectory, bootstrapFile), obfuscateSource(
          `${staticPrelude}\n${socketSource}\nglobalThis.WebSocket = staticSocketClass(globalThis.WebSocket);`,
          RUNTIME_OBFUSCATION_OPTIONS, obfuscationPrefix(buildId, "/b/static.js")));
      }

      for (const { logicalPath, source } of RUNTIME_ASSETS) {
        const sourcePath = path.join(projectRoot, ...source);
        const emittedPath = path.join(
          outputDirectory,
          runtimePaths[logicalPath].slice(1),
        );
        let contents;
        try {
          contents = await readFile(sourcePath);
        } catch {
          throw new Error("required runtime artifact is missing... /ᐠ - ˕ -マ");
        }

        if (/\.(m?js)$/.test(logicalPath)) {
          let sourceCode = rewriteBuildTokens(
            stripSourceMapComments(contents.toString("utf8")),
            cssTokenMap,
            pathAliases,
          );
          if (staticBase && /^\/(?:epoxy|libcurl)\//.test(logicalPath)) {
            sourceCode = `${staticPrelude}\n${socketSource}\nconst WebSocket = staticSocketClass(globalThis.WebSocket);\n${sourceCode}`;
          }
          if (!staticBase && /^\/(?:epoxy|libcurl)\//.test(logicalPath)) {
            sourceCode = `${nuruSocketSource}\nconst WebSocket = nuruSocketClass(globalThis.WebSocket, ${JSON.stringify(wispPath)});\n${sourceCode}`;
          }
          if (staticBase && logicalPath === "/b/fl/controller.inject.js") {
            sourceCode = `${staticPrelude}\n${sourceCode}`;
          }
          contents = obfuscateSource(
            sourceCode,
            RUNTIME_OBFUSCATION_OPTIONS,
            obfuscationPrefix(buildId, logicalPath),
          );
        }
        await writeFile(emittedPath, contents);
      }

      const bundleInputPaths = [
        path.join(projectRoot, "public", "b", "fl", "folio.js"),
        path.join(projectRoot, "public", "b", "fl", "controller.api.js"),
        path.join(projectRoot, "public", "b", "fl", "folio-utils.js"),
      ];
      const bundleParts = [
        'try { localStorage.removeItem(["bare", "mux", "path"].join("-")); } catch {}',
      ];
      for (const bundleInputPath of bundleInputPaths) {
        try {
          const sourceCode = stripSourceMapComments(
            (await readFile(bundleInputPath, "utf8")).replace(/\r\n/g, "\n"),
          ).trim();
          bundleParts.push(sourceCode);
        } catch {
          throw new Error("required runtime bundle is missing... /ᐠ - ˕ -マ");
        }
      }
      const runtimeBundle = rewriteBuildTokens(
        bundleParts.join(";\n"),
        cssTokenMap,
        pathAliases,
      );
      await writeFile(
        path.join(outputDirectory, runtimeBundleFileName),
        obfuscateSource(
          runtimeBundle,
          RUNTIME_OBFUSCATION_OPTIONS,
          obfuscationPrefix(buildId, "/b/all.js"),
        ),
      );

      const moduleSources = await Promise.all(
        SW_MODULES.map((moduleName) =>
          readFile(path.join(serviceWorkerSourceDirectory, moduleName), "utf8"),
        ),
      );
      let serviceWorkerCode = moduleSources.join("\n");
      if (staticBase) {
        const staticWorker = (await readFile(path.join(projectRoot, "src/static/worker.js"), "utf8"))
          .replace('"__STATIC_BASE__"', JSON.stringify(staticBase));
        serviceWorkerCode = serviceWorkerCode
          .replace('const PRECACHE = [\n  "/",', `const PRECACHE = [\n  ${JSON.stringify(staticBase + "index.html")},`);
        serviceWorkerCode = `${staticPrelude}\nconst STATIC_SOCKET_SOURCE = ${JSON.stringify(staticPrelude + "\n" + socketSource + "\nglobalThis.WebSocket = staticSocketClass(globalThis.WebSocket);")};\n${staticWorker}\n${serviceWorkerCode}\nself.addEventListener("fetch", event => {
          const url = new URL(event.request.url);
          if (url.origin === self.location.origin && staticBackendPath(staticPath(url)))
            event.respondWith(staticForward(event.request, event));
        });`;
      }
      serviceWorkerCode = serviceWorkerCode
        .replace(/__BUILD_ID__/g, buildId)
        .replace(
          /(['"])__PRECACHE_ASSETS__\1/g,
          JSON.stringify(precacheAssets),
        );
      serviceWorkerCode = rewriteBuildTokens(
        serviceWorkerCode,
        cssTokenMap,
        pathAliases,
      );

      const obfuscatedServiceWorker = obfuscateSource(
        serviceWorkerCode,
        OBFUSCATION_OPTIONS,
        obfuscationPrefix(buildId, "/b/sw.js"),
      );
      const serviceWorkerHash = createHash("md5")
        .update(obfuscatedServiceWorker)
        .digest("hex")
        .slice(0, 10);
      const serviceWorkerFileName = `${staticBase ? "" : "b/"}${serviceWorkerHash}.js`;
      pathAliases.set("/b/sw.js", `${staticBase || "/"}${serviceWorkerFileName}`);

      const pageAliases = new Map([...pathAliases].map(([logicalPath, emittedPath]) =>
        [logicalPath, `./${emittedPath.slice((staticBase || "/").length)}`],
      ));
      pageAliases.set("/assets/images/", "./assets/images/");

      await writeFile(
        path.join(outputDirectory, "build-meta.json"),
        JSON.stringify({ build: buildId, ...(staticBase ? {
          version: JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version,
            protocol: 2, base: staticBase, backend: staticBackends[0], backends: staticBackends,
        } : {}) }),
      );
      await writeFile(
        path.join(outputDirectory, serviceWorkerFileName),
        obfuscatedServiceWorker,
      );

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "asset" && /\.(css|html)$/.test(fileName)) {
          const filePath = path.join(outputDirectory, fileName);
          const sourceCode = await readFile(filePath, "utf8");
          const isPage = fileName.endsWith(".html");
          const rewritten = rewriteBuildTokens(
            isPage
              ? rewritePageDomNames(sourceCode, domNames, (source) => this.parse(source))
              : sourceCode,
            cssTokenMap,
            isPage ? pageAliases : pathAliases,
          );
          await writeFile(
            filePath,
            isPage ? obfuscateInlinePageCode(rewritten, buildId, fileName) : rewritten,
          );
          continue;
        }
        if (chunk.type === "asset" && fileName.endsWith(".js")) {
          const filePath = path.join(outputDirectory, fileName);
          const sourceCode = stripSourceMapComments(
            await readFile(filePath, "utf8"),
          );
          await writeFile(
            filePath,
            obfuscateSource(
              rewriteBuildTokens(sourceCode, cssTokenMap, pathAliases),
              OBFUSCATION_OPTIONS,
              obfuscationPrefix(buildId, fileName),
            ),
          );
          continue;
        }
        if (chunk.type !== "chunk") continue;
        const filePath = path.join(outputDirectory, fileName);
        let sourceCode;
        try {
          sourceCode = await readFile(filePath, "utf8");
        } catch {
          continue;
        }

        sourceCode = rewriteBuildTokens(sourceCode, cssTokenMap, pageAliases);
        sourceCode = containsAppCode(chunk, projectRoot)
          ? obfuscateSource(
              sourceCode,
              OBFUSCATION_OPTIONS,
              obfuscationPrefix(buildId, fileName),
            )
          : encodeLibrarySource(sourceCode);

        await writeFile(filePath, sourceCode);
      }

      async function compressDirectory(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        await Promise.all(
          entries.map(async (entry) => {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              await compressDirectory(filePath);
            } else if (/\.(js|css|html|mjs|wasm)$/.test(entry.name)) {
              const contents = await readFile(filePath);
              const [brotli, gzipped] = await Promise.all([
                brotliCompressAsync(contents, {
                  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
                }),
                gzipAsync(contents, { level: 9 }),
              ]);
              await Promise.all([
                writeFile(filePath + ".br", brotli),
                writeFile(filePath + ".gz", gzipped),
              ]);
            }
          }),
        );
      }

      try {
        await cp(
          path.join(projectRoot, "src", "assets", "images"),
          path.join(outputDirectory, "assets", "images"),
          { recursive: true, ...(staticBase ? { filter: (source) => !path.basename(source).startsWith(".") } : {}) },
        );
      } catch {}

      if (!staticBase) await compressDirectory(outputDirectory);
      if (staticBase) {
        await writeFile(path.join(outputDirectory, "_headers"),
          `${staticBase}${serviceWorkerFileName}\n  Cache-Control: no-cache\n${staticBase}*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n  Referrer-Policy: no-referrer\n`);
      }

      console.log(`\nbuild id: ${buildId}`);
      console.log(`sw: /${serviceWorkerFileName}`);
      console.log(`bundle: /${runtimeBundleFileName}`);
      console.log(`precache: ${precacheAssets.length} asset(s)`);
    },
  };
}
