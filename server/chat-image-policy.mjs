export const IMAGE_RULES = [
  { score: "explicit", category: "sexual", limit: 0.5 },
  { score: "youthful", category: "sexual", limit: 0.5 },
  { score: "graphic", category: "gore", limit: 0.4 },
  { score: "sexual", category: "sexual", limit: 0.02 },
  { score: "gore", category: "gore", limit: 0.01 },
  { score: "hate", category: "hate", limit: 0.005 },
];

export const IMAGE_COVERAGE = { screen: "safety", screenCrops: 96, diverseCrops: 12, flaggedCrops: 24, flag: 0.15 };

export function flaggedFrames(screened, boxes) {
  const frames = [];
  for (let frame = 0; frame * boxes < screened.length; frame += 1) {
    const readings = screened.slice(frame * boxes, (frame + 1) * boxes);
    if (readings.some((reading) => Math.max(reading.NSFW, reading.NSFL) >= IMAGE_COVERAGE.flag)) frames.push(frame);
  }
  return frames;
}

function cropScores({ clip, nsfw, safety }) {
  const explicit = nsfw.hentai + nsfw.porn;
  return {
    explicit,
    youthful: clip.minor > clip.adult ? explicit + nsfw.sexy : 0,
    graphic: safety.NSFL,
    sexual: clip.sexual - clip.safe,
    gore: clip.gore - clip.safe,
    hate: clip.hate - clip.safe,
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
