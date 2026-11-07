import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];

const runtimeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  btoa: "readonly",
  Buffer: "readonly",
  Bun: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  CloseEvent: "readonly",
  console: "readonly",
  crypto: "readonly",
  document: "readonly",
  DOMException: "readonly",
  Event: "readonly",
  EventTarget: "readonly",
  fetch: "readonly",
  Headers: "readonly",
  HTMLRewriter: "readonly",
  localStorage: "readonly",
  MediaSource: "readonly",
  MessageChannel: "readonly",
  MessageEvent: "readonly",
  performance: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  ReadableStream: "readonly",
  requestAnimationFrame: "readonly",
  Request: "readonly",
  Response: "readonly",
  sessionStorage: "readonly",
  self: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  TransformStream: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
  window: "readonly",
  Worker: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "dist-static/**",
      "node_modules/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.types/**",
      "public/b/**",
      "target/**",
      "services/**/target/**",
      "src/b/**",
      "vendor/**",
      "cache/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: runtimeGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["src/static/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { STATIC_SOCKET_SOURCE: "readonly" },
    },
    rules: { "no-unused-vars": ["warn", { argsIgnorePattern: "^_", vars: "local" }] },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { __dirname: "readonly", __filename: "readonly" },
    },
  },
];
