export type ModerationCategory =
  | "slur"
  | "threat"
  | "self_harm"
  | "crisis"
  | "sexual"
  | "doxxing"
  | "hate"
  | "harassment"
  | "gore";

const CATEGORY_LABELS: Record<ModerationCategory, string> = {
  slur: "slurs",
  threat: "threats",
  self_harm: "encouraging self-harm",
  crisis: "self-harm",
  sexual: "sexual content",
  doxxing: "sharing personal info",
  hate: "hate speech",
  harassment: "harassment",
  gore: "gore or shock content",
};

export function isModerationCategory(value: unknown): value is ModerationCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORY_LABELS, value);
}

export function blockedNotice(subject: string, category: ModerationCategory, tense: "was" | "would be" = "was"): string {
  if (category === "crisis") {
    return `that ${subject} ${tense === "was" ? "was not" : "will not be"} posted.  findahelpline.com can connect you with someone to talk to`;
  }
  return `that ${subject} ${tense} blocked for ${CATEGORY_LABELS[category]}`;
}
