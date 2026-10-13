import {
  moodResultSchema,
  type MoodResult,
  type PrimaryEmotion,
} from "./index";

export const SECONDARY_MOOD_OPTIONS = [
  "bright",
  "playful",
  "nostalgic",
  "lively",
  "bold",
  "electric anticipation",
  "dreamy",
  "warm",
  "peaceful",
  "vibrant",
  "reflective",
  "tender",
  "curious",
  "serene",
  "mysterious",
] as const;

export interface MoodCorrectionState {
  readonly originalMood: MoodResult;
  readonly currentMood: MoodResult;
  readonly draftPrimaryEmotion: PrimaryEmotion;
  readonly draftSecondaryMoods: string[];
  readonly editorOpen: boolean;
  readonly corrected: boolean;
}

export type MoodCorrectionAction =
  | { readonly type: "open" }
  | { readonly type: "cancel" }
  | { readonly type: "choose-primary"; readonly emotion: PrimaryEmotion }
  | { readonly type: "toggle-secondary"; readonly mood: string }
  | { readonly type: "apply" }
  | { readonly type: "reset" };

export function createMoodCorrectionState(mood: MoodResult): MoodCorrectionState {
  return {
    originalMood: mood,
    currentMood: mood,
    draftPrimaryEmotion: mood.primaryEmotion,
    draftSecondaryMoods: [...mood.secondaryMoods],
    editorOpen: false,
    corrected: false,
  };
}

export function isMoodCorrectionDirty(state: MoodCorrectionState): boolean {
  return (
    state.draftPrimaryEmotion !== state.currentMood.primaryEmotion ||
    state.draftSecondaryMoods.length !== state.currentMood.secondaryMoods.length ||
    state.draftSecondaryMoods.some((mood, index) => mood !== state.currentMood.secondaryMoods[index])
  );
}

export function moodCorrectionReducer(
  state: MoodCorrectionState,
  action: MoodCorrectionAction,
): MoodCorrectionState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        draftPrimaryEmotion: state.currentMood.primaryEmotion,
        draftSecondaryMoods: [...state.currentMood.secondaryMoods],
        editorOpen: true,
      };
    case "cancel":
      return { ...state, editorOpen: false };
    case "choose-primary":
      return { ...state, draftPrimaryEmotion: action.emotion };
    case "toggle-secondary": {
      const selected = state.draftSecondaryMoods.includes(action.mood);
      if (!selected && state.draftSecondaryMoods.length >= 3) return state;
      return {
        ...state,
        draftSecondaryMoods: selected
          ? state.draftSecondaryMoods.filter((mood) => mood !== action.mood)
          : [...state.draftSecondaryMoods, action.mood],
      };
    }
    case "apply": {
      if (!isMoodCorrectionDirty(state)) return { ...state, editorOpen: false };
      const currentMood = moodResultSchema.parse({
        ...state.currentMood,
        primaryEmotion: state.draftPrimaryEmotion,
        secondaryMoods: state.draftSecondaryMoods,
      });
      return { ...state, currentMood, editorOpen: false, corrected: true };
    }
    case "reset":
      return {
        ...state,
        currentMood: state.originalMood,
        draftPrimaryEmotion: state.originalMood.primaryEmotion,
        draftSecondaryMoods: [...state.originalMood.secondaryMoods],
        editorOpen: false,
        corrected: false,
      };
  }
}
