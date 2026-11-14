export const IMAGE_RULES = [
  { score: "explicit", category: "sexual", limit: 0.5 },
  { score: "explicitAgreed", category: "sexual", limit: 0.2 },
  { score: "youthful", category: "sexual", limit: 0.25 },
  { score: "graphic", category: "gore", limit: 0.75 },
  { score: "gore", category: "gore", limit: 0.45 },
  { score: "hate", category: "hate", limit: 0.1 },
];

export const IMAGE_COVERAGE = { screen: "safety", screenCrops: 192 };
export const VIDEO_COVERAGE = { everySeconds: 1, crops: 96, side: 640 };

const CLEARLY_YOUNG = 0.8;

function cropScores({ clip, nsfw, safety }) {
  const explicit = Math.min(nsfw.hentai + nsfw.porn, clip.sexual);
  return {
    explicit,
    explicitAgreed: Math.min(explicit, safety.NSFW),
    youthful: clip.minor >= CLEARLY_YOUNG ? explicit : 0,
    graphic: safety.NSFL,
    gore: Math.min(safety.NSFL, clip.gore),
    hate: clip.hate,
  };
}

export function scoreImage(crops, screened = crops.map((crop) => crop.safety)) {
  const scores = {};
  for (const crop of crops) {
    for (const [score, value] of Object.entries(cropScores(crop))) scores[score] = Math.max(scores[score] ?? -Infinity, value);
  }
  for (const reading of screened) scores.graphic = Math.max(scores.graphic ?? -Infinity, reading.NSFL);
  return scores;
}

export function imageVerdict(scores) {
  let worst;
  let worstRatio = 0;
  for (const rule of IMAGE_RULES) {
    const ratio = (scores[rule.score] ?? -1) / rule.limit;
    if (ratio >= 1 && ratio > worstRatio) {
      worst = rule;
      worstRatio = ratio;
    }
  }
  return worst ? { allowed: false, category: worst.category } : { allowed: true };
}
