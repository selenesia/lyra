import { options } from "preact";
import { clientBuildId } from "../runtime/build.ts";

export interface DomNames {
  list(value: string): string;
  selector(value: string): string;
  markup(value: string): string;
}

export const DOM_NAME_ATTRIBUTES = [
  "class",
  "id",
  "for",
  "list",
  "form",
  "headers",
  "popovertarget",
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
];

const ELEMENT_NAME_PROPS = [...DOM_NAME_ATTRIBUTES, "className", "htmlFor"];
const TOKEN_PATTERN = /^x[0-9a-f]{12}$/;
const NAME_PATTERN = /\S+/g;
const SELECTOR_PATTERN =
  /\[[^\]]*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|([.#])(-?[_a-zA-Z][\w-]*)/g;
const MARKUP_ATTRIBUTE_PATTERN = new RegExp(
  `(\\s(?:${DOM_NAME_ATTRIBUTES.join("|")})\\s*=\\s*)(?:"([^"]*)"|'([^']*)')`,
  "gi",
);
const CACHE_LIMIT = 4096;

function unchanged(value: string): string {
  return value;
}

function hashDomName(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    ((h2 >>> 0) & 0xffff).toString(16).padStart(4, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}

function cached(map: (value: string) => string): (value: string) => string {
  const results = new Map<string, string>();
  return (value) => {
    let result = results.get(value);
    if (result === undefined) {
      if (results.size >= CACHE_LIMIT) results.clear();
      result = map(value);
      results.set(value, result);
    }
    return result;
  };
}

export function createDomNames(salt: string): DomNames {
  if (!salt) return { list: unchanged, selector: unchanged, markup: unchanged };
  const name = cached((value) =>
    TOKEN_PATTERN.test(value) ? value : `x${hashDomName(`${salt}\0${value}`)}`,
  );
  const list = cached((value) => value.replace(NAME_PATTERN, name));
  const selector = cached((value) =>
    value.replace(
      SELECTOR_PATTERN,
      (match, sigil: string | undefined, identifier: string | undefined) =>
        sigil && identifier ? sigil + name(identifier) : match,
    ),
  );
  const markup = (value: string) =>
    value.replace(
      MARKUP_ATTRIBUTE_PATTERN,
      (_match, prefix: string, double: string | undefined, single: string | undefined) =>
        double === undefined
          ? `${prefix}'${list(single ?? "")}'`
          : `${prefix}"${list(double)}"`,
    );
  return { list, selector, markup };
}

export function mapElementProps(
  props: Record<string, unknown>,
  names: DomNames,
): void {
  for (const key of ELEMENT_NAME_PROPS) {
    const value = props[key];
    if (typeof value !== "string") continue;
    const mapped = names.list(value);
    if (mapped !== value && Object.getOwnPropertyDescriptor(props, key)?.writable) {
      props[key] = mapped;
    }
  }
}

const runtimeNames = createDomNames(clientBuildId);

export function mapDomNames<T>(value: T): T {
  return (typeof value === "string" ? runtimeNames.list(value) : value) as T;
}

export function mapDomSelector<T>(value: T): T {
  return (typeof value === "string" ? runtimeNames.selector(value) : value) as T;
}

export function mapDomMarkup<T>(value: T): T {
  return (typeof value === "string" ? runtimeNames.markup(value) : value) as T;
}

if (clientBuildId) {
  const previousVNodeHook = options.vnode;
  options.vnode = (vnode) => {
    if (typeof vnode.type === "string") {
      mapElementProps(vnode.props as Record<string, unknown>, runtimeNames);
    }
    previousVNodeHook?.(vnode);
  };
}
