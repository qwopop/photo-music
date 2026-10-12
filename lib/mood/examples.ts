import type { MoodResult } from "./index";

/** Synthetic interpretations for documentation/tests; no photo or provider response. */
export const MOOD_EXAMPLES = [
  {
    primaryEmotion: "happy",
    secondaryMoods: ["bright", "playful"],
    explanation: "The warm golden light suggests a cheerful atmosphere.",
    confidence: 0.8,
  },
  {
    primaryEmotion: "sad",
    secondaryMoods: ["nostalgic"],
    explanation: "Muted blue tones and an empty street suggest a wistful atmosphere.",
    confidence: 0.65,
  },
  {
    primaryEmotion: "calm",
    secondaryMoods: [],
    explanation: "The soft evening light suggests a calm atmosphere.",
    confidence: 0,
  },
  {
    primaryEmotion: "energetic",
    secondaryMoods: ["lively", "bold", "electric anticipation"],
    explanation: "Vivid colors and streaks of city light suggest an energetic atmosphere.",
    confidence: 1,
  },
  {
    primaryEmotion: "romantic",
    secondaryMoods: ["dreamy", "warm"],
    explanation: "Soft rosy light and a quiet garden suggest a romantic atmosphere.",
    confidence: 0.7,
  },
] satisfies MoodResult[];
