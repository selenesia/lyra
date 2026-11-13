export const MESSAGE_TOKEN =
  /(`[^`]+`)|(\|\|.+?\|\|)|(\*\*.+?\*\*)|(~~.+?~~)|(\*[^*\s](?:[^*]*[^*\s])?\*)|(\b_[^_\s](?:[^_]*[^_\s])?_\b)|(https?:\/\/[^\s<>"]*[^\s<>".,:;!?)\]'])|(?<![\p{L}\p{N}_@./-])(@[A-Za-z0-9_]{3,20})(?![\p{L}\p{N}_@-])|(?<![\p{L}\p{N}_&#/.@-])(#[A-Za-z0-9][A-Za-z0-9-]{0,31})(?![\p{L}\p{N}_-])/gu;

export function mentionsName(text: string, name: string, depth = 0): boolean {
  if (!name) return false;
  const wanted = name.toLowerCase();
  for (const match of text.matchAll(MESSAGE_TOKEN)) {
    const [token, code, spoiler, bold, strike, star, underscore, link, mention] = match;
    if (mention && mention.slice(1).toLowerCase() === wanted) return true;
    if (code || link || mention || depth >= 3) continue;
    const inset = spoiler || bold || strike ? 2 : star || underscore ? 1 : 0;
    if (inset && mentionsName(token.slice(inset, -inset), name, depth + 1)) return true;
  }
  return false;
}
