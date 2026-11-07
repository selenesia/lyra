import { NEGATIVE } from "./messages";

const GLOBAL_ALIASES = new Set<PropertyKey>([
  "self",
  "window",
  "globalThis",
  "frames",
]);
const FRAME_ALIASES = new Set<PropertyKey>(["top", "parent"]);

const scopesByWindow = new WeakMap<Window, Map<string, object>>();

function hasOwn(target: object, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(target, property);
}

function windowSetterFor(win: Window, property: PropertyKey): boolean {
  let target: object | null = win;
  while (target) {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor) return typeof descriptor.set === "function";
    target = Object.getPrototypeOf(target) as object | null;
  }
  return false;
}

function scopeKey(): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2);
  return `_${random}`;
}

export function createContentScriptScope(
  win: Window,
  extId: string,
  bindings: Record<string, unknown>,
): object {
  const own = Object.create(null) as Record<PropertyKey, unknown>;
  for (const [name, value] of Object.entries(bindings)) {
    Object.defineProperty(own, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
  }
  const methods = new WeakMap<object, unknown>();
  const scope: object = new Proxy(own, {
    has(target, property) {
      return (
        hasOwn(target, property) ||
        GLOBAL_ALIASES.has(property) ||
        Reflect.has(win, property)
      );
    },
    get(target, property) {
      if (hasOwn(target, property)) return target[property];
      if (GLOBAL_ALIASES.has(property)) return scope;
      const value = Reflect.get(win, property, win) as unknown;
      if (value === win && FRAME_ALIASES.has(property)) return scope;
      if (typeof value !== "function" || "prototype" in value) return value;
      let method = methods.get(value);
      if (!method) {
        method = new Proxy(value, {
          apply: (fn, thisArg, args) =>
            Reflect.apply(fn, thisArg === scope ? win : thisArg, args),
        });
        methods.set(value, method);
      }
      return method;
    },
    set(target, property, value) {
      if (!hasOwn(target, property) && windowSetterFor(win, property)) {
        return Reflect.set(win, property, value, win);
      }
      return Reflect.defineProperty(target, property, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(win) as object | null;
    },
  });
  let scopes = scopesByWindow.get(win);
  if (!scopes) {
    scopes = new Map();
    scopesByWindow.set(win, scopes);
  }
  scopes.set(extId, scope);
  return scope;
}

export function contentScriptScope(
  win: Window,
  extId: string,
): object | undefined {
  return scopesByWindow.get(win)?.get(extId);
}

export function runInContentScope(
  win: Window,
  scope: object,
  body: string,
): unknown {
  return injectIntoContentScope(
    win,
    scope,
    (key) =>
      `${key}.result = (function () {\n${body}\n}).call(globalThis);`,
  );
}

export function evaluateInContentScope(
  win: Window,
  scope: object,
  source: string,
): unknown {
  return injectIntoContentScope(
    win,
    scope,
    (key) =>
      `${key}.result = (function (eval) {\nreturn eval(${key}.source);\n}).call(globalThis, ${key}.evaluate);`,
    { source, evaluate: (win as Window & { eval: unknown }).eval },
  );
}

function injectIntoContentScope(
  win: Window,
  scope: object,
  statement: (key: string) => string,
  values: Record<string, unknown> = {},
): unknown {
  const key = scopeKey();
  const handoff = { ...values, scope, result: undefined as unknown };
  try {
    Object.defineProperty(win, key, {
      configurable: true,
      enumerable: false,
      get: () => {
        Reflect.deleteProperty(win, key);
        return handoff;
      },
    });
    const doc = win.document;
    const script = doc.createElement("script");
    script.appendChild(
      doc.createTextNode(
        `((${key}) => {\nwith (${key}.scope) {\n${statement(key)}\n}\n})(this[${JSON.stringify(key)}]);`,
      ),
    );
    (doc.head || doc.documentElement).appendChild(script);
    script.remove();
    script.textContent = "";
  } catch (e) {
    console.warn("[rivet] script injection failed", e, NEGATIVE);
  } finally {
    Reflect.deleteProperty(win, key);
  }
  return handoff.result;
}
