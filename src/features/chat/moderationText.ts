const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p",
  с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d",
  ɡ: "g", ɑ: "a", α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v",
  ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ß: "ss", æ: "ae", ø: "o", đ: "d",
  ł: "l", ı: "i",
};

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t",
  "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t",
  "€": "e", "£": "l", "¡": "i",
};

const HIDDEN = /[\p{M}\p{Cf}]+/gu;
const NON_ASCII = /[^\x00-\x7f]/g;
const LEET_CHARS = /[0-9@$!|+€£¡]/g;
const LEET_RUN = /[a-z0-9@$!|+€£¡]+/g;
const APOSTROPHES = /['’‘`´]/g;
const MENTION = /(^|\s)@[\p{L}\p{N}._-]+/gu;
const MASKED = /[a-z*#_]*[*#_][a-z*#_]*/g;
const MASK_CHARS = /[*#_]/g;
const MASKABLE = [
  "nigger", "niggers", "nigga", "niggas", "faggot", "faggots", "fag", "fags", "tranny", "retard", "retarded", "chink",
  "spic", "kike", "coon", "kill", "kys", "kms", "yourself", "urself", "myself", "suicide", "die", "rape", "raped",
  "dick", "cock", "pussy", "cunt", "fuck", "fucking", "shit", "bitch", "nudes", "sex", "cum", "porn", "whore", "slut",
  "nazi", "hitler",
];

export interface ModerationText {
  folded: string;
  tokens: string[];
  contentTokens: string[];
  plain: string;
  squashed: string;
  compact: string;
  wordEdges: Set<number>;
}

export function squeeze(word: string): string {
  return word.replace(/([a-z])\1+/g, "$1");
}

export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(HIDDEN, "")
    .toLowerCase()
    .replace(NON_ASCII, (char) => CONFUSABLES[char] ?? char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z]/.test(char);
}

function readsAsLetter(
  char: string,
  before: string | undefined,
  after: string | undefined,
): boolean {
  if (char === "!" || char === "|" || char === "¡" || char === "+") {
    return isWordChar(after) && (char !== "+" || isWordChar(before));
  }
  return isWordChar(before) || isWordChar(after);
}

function readLeetRun(run: string): string {
  if (!/[a-z]/.test(run)) return run;
  const letters = run.replace(/[^a-z]/g, "").length;
  return run.replace(LEET_CHARS, (char, offset: number) => {
    const before = run[offset - 1];
    const after = run[offset + 1];
    const near = readsAsLetter(char, before, after);
    const inside = letters >= 2 && offset > 0 && offset < run.length - 1 && !"!|¡+".includes(char);
    return near || inside ? (LEET[char] ?? char) : char;
  });
}

function mergeSpelledOut(parts: string[]): string[] {
  const merged: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) merged.push(run.join(""));
    else merged.push(...run);
    run = [];
  };
  for (const part of parts) {
    if (part.length === 1) {
      run.push(part);
      continue;
    }
    flush();
    merged.push(part);
  }
  flush();
  return merged;
}

function unmask(word: string): string {
  const letters = word.replace(MASK_CHARS, "").length;
  if (word.length < 3 || !letters || letters * 3 < word.length) return word;
  const pattern = new RegExp(`^${word.replace(MASK_CHARS, "[a-z]")}$`);
  const matches = MASKABLE.filter((candidate) => pattern.test(candidate));
  return matches.length === 1 ? matches[0]! : word;
}

function tokenize(folded: string): string[] {
  const leet = folded
    .replace(APOSTROPHES, "")
    .replace(LEET_RUN, readLeetRun)
    .replace(MASKED, unmask);
  return mergeSpelledOut(leet.split(/[^a-z]+/).filter(Boolean));
}

export function readModerationText(text: string): ModerationText {
  const folded = foldText(text);
  const tokens = tokenize(folded);
  const withoutMentions = folded.replace(MENTION, " ");
  const contentTokens = withoutMentions === folded ? tokens : tokenize(withoutMentions);
  const squeezed = tokens.map(squeeze);
  const wordEdges = new Set([0]);
  let edge = 0;
  for (const word of squeezed) wordEdges.add((edge += word.length));
  return {
    folded,
    tokens,
    contentTokens,
    plain: ` ${squeezed.join(" ")} `,
    squashed: tokens.join(""),
    compact: squeezed.join(""),
    wordEdges,
  };
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function featureBuckets(tokens: string[], buckets: number): number[] {
  const words = tokens.map(squeeze);
  const seen = new Set<number>();
  const add = (feature: string) => seen.add(fnv1a(feature) % buckets);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    add(`u:${word}`);
    if (index > 0) add(`b:${words[index - 1]} ${word}`);
    if (index > 1) add(`s:${words[index - 2]} ${word}`);
    const padded = ` ${word} `;
    for (let start = 0; start + 3 <= padded.length; start += 1) {
      add(`c:${padded.slice(start, start + 3)}`);
    }
  }
  return [...seen];
}
