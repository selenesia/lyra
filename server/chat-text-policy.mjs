export const TEXT_RULES = [
  { score: "minors", category: "sexual", limit: 0.85, strikes: 2 },
  { score: "selfHarm", category: "crisis", limit: 0.9, strikes: 0, unless: "hyperbole" },
  { score: "threat", category: "threat", limit: 0.85, strikes: 1, unless: "playful" },
  { score: "hate", category: "hate", limit: 0.75, strikes: 1 },
];

export const TEXT_CONFIRM = {
  threat: { score: "threat", limit: 0.5 },
  hate: { score: "identity", limit: 0.5 },
};

export const TEXT_SCORES = [...new Set([...TEXT_RULES, ...Object.values(TEXT_CONFIRM)].map((rule) => rule.score))];

export function scoreText({ moderation, toxicity }) {
  return {
    hate: Math.min(moderation.hate, toxicity.identity_attack),
    identity: Math.max(moderation.hate, toxicity.identity_attack),
    threat: Math.min(moderation["harassment/threatening"], toxicity.threat),
    minors: moderation["sexual/minors"],
    selfHarm: moderation["self-harm/intent"],
  };
}

const blockedFor = ({ category, strikes }) => ({ allowed: false, category, strikes });

export function textVerdict(reading, scores) {
  if (!reading.verdict.allowed) return reading.verdict;
  const { suspect } = reading;
  if (!scores) return suspect ? blockedFor({ category: suspect.category, strikes: 0 }) : reading.verdict;
  if (suspect) {
    const confirm = TEXT_CONFIRM[suspect.category];
    if (!confirm || scores[confirm.score] >= confirm.limit) return blockedFor(suspect);
  }
  let worst;
  let worstRatio = 0;
  for (const rule of TEXT_RULES) {
    if (rule.unless && reading[rule.unless]) continue;
    const ratio = scores[rule.score] / rule.limit;
    if (ratio >= 1 && ratio > worstRatio) {
      worst = rule;
      worstRatio = ratio;
    }
  }
  return worst ? blockedFor(worst) : reading.verdict;
}
