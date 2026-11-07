const PIECES = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
const CACHE_LIMIT = 20_000;

function byteSymbols() {
  const kept = [];
  for (let byte = 33; byte <= 126; byte += 1) kept.push(byte);
  for (let byte = 161; byte <= 172; byte += 1) kept.push(byte);
  for (let byte = 174; byte <= 255; byte += 1) kept.push(byte);
  const symbols = new Map(kept.map((byte) => [byte, String.fromCharCode(byte)]));
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (!symbols.has(byte)) symbols.set(byte, String.fromCharCode(256 + extra++));
  }
  return Array.from({ length: 256 }, (_, byte) => symbols.get(byte));
}

export function createByteLevelTokenizer(spec) {
  if (spec?.model?.type !== "BPE" || spec.pre_tokenizer?.type !== "ByteLevel") throw new TypeError("byte-level bpe tokenizer expected");
  const vocab = new Map(Object.entries(spec.model.vocab));
  const ranks = new Map(spec.model.merges.map((merge, rank) => [Array.isArray(merge) ? merge.join(" ") : merge, rank]));
  const symbols = byteSymbols();
  const encoder = new TextEncoder();
  const cache = new Map();

  function bpe(word) {
    let parts = [...word];
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const rank = ranks.get(`${parts[index]} ${parts[index + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = index;
        }
      }
      if (best < 0) break;
      const [first, second] = [parts[best], parts[best + 1]];
      const next = [];
      for (let index = 0; index < parts.length; index += 1) {
        if (parts[index] === first && parts[index + 1] === second) {
          next.push(first + second);
          index += 1;
        } else next.push(parts[index]);
      }
      parts = next;
    }
    return parts.flatMap((part) => (vocab.has(part) ? [vocab.get(part)] : []));
  }

  function piece(text) {
    let ids = cache.get(text);
    if (!ids) {
      ids = bpe(Array.from(encoder.encode(text), (byte) => symbols[byte]).join(""));
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(text, ids);
    }
    return ids;
  }

  return (text) => (text.match(PIECES) ?? []).flatMap(piece);
}
