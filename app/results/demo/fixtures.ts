import { MOOD_EXAMPLES, moodResultSchema } from "../../../lib/mood";
import type { MoodResult } from "../../../lib/mood";
import type { PaletteResult } from "../../../lib/palette";

export const DEMO_MOOD_KEYS = ["happy", "sad", "calm", "energetic", "romantic"] as const;
export const DEMO_PALETTE_KEYS = ["bright", "dark", "solid"] as const;

export type DemoMoodKey = (typeof DEMO_MOOD_KEYS)[number];
export type DemoPaletteKey = (typeof DEMO_PALETTE_KEYS)[number];

const palettes: Record<DemoPaletteKey, PaletteResult> = {
  bright: {
    colors: ["#f4c6a8", "#e18b65", "#ffd166", "#8ecae6", "#6d597a", "#f7ede2"],
    brightness: 0.68,
  },
  dark: {
    colors: ["#20243a", "#556b8a", "#a8dadc", "#e63946", "#f1faee", "#cdb4db"],
    brightness: 0.31,
  },
  solid: {
    colors: Array(6).fill("#777777"),
    brightness: 0.47,
  },
};

const stressExplanation =
  "Soft light and color may suggest a reflective atmosphere. ".repeat(10).slice(0, 500);
const longMoodTag = "m".repeat(40);

export interface DemoFixture {
  readonly mood: MoodResult;
  readonly palette: PaletteResult;
}

function isChoice<T extends string>(value: string | undefined, choices: readonly T[]): value is T {
  return value !== undefined && choices.includes(value as T);
}

export function selectDemoFixture(
  moodValue: string | undefined,
  paletteValue: string | undefined,
  stressValue: string | undefined,
): DemoFixture {
  const moodKey = isChoice(moodValue, DEMO_MOOD_KEYS) ? moodValue : "happy";
  const paletteKey = isChoice(paletteValue, DEMO_PALETTE_KEYS) ? paletteValue : "bright";
  const mood = MOOD_EXAMPLES.find((example) => example.primaryEmotion === moodKey) ?? MOOD_EXAMPLES[0];
  const stressedMood = stressValue === "1"
    ? moodResultSchema.parse({ ...mood, secondaryMoods: [longMoodTag], explanation: stressExplanation })
    : mood;
  return { mood: stressedMood, palette: palettes[paletteKey] };
}
