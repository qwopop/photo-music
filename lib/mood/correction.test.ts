import { describe, expect, it } from "vitest";
import {
  MOOD_EXAMPLES,
  PRIMARY_EMOTIONS,
  SECONDARY_MOOD_OPTIONS,
  createMoodCorrectionState,
  isMoodCorrectionDirty,
  moodCorrectionReducer,
  moodResultSchema,
} from "./index";

describe("mood correction", () => {
  it("offers 12–20 fixed tags including every synthetic example tag", () => {
    expect(SECONDARY_MOOD_OPTIONS.length).toBeGreaterThanOrEqual(12);
    expect(SECONDARY_MOOD_OPTIONS.length).toBeLessThanOrEqual(20);
    for (const tag of SECONDARY_MOOD_OPTIONS) {
      expect([...tag].length).toBeGreaterThanOrEqual(1);
      expect([...tag].length).toBeLessThanOrEqual(40);
    }
    for (const mood of MOOD_EXAMPLES) {
      for (const tag of mood.secondaryMoods) expect(SECONDARY_MOOD_OPTIONS).toContain(tag);
    }
  });

  it("selects a different primary emotion, adds up to three tags, applies and preserves the reading", () => {
    const original = { ...MOOD_EXAMPLES[0], secondaryMoods: ["bright"] };
    let state = createMoodCorrectionState(original);
    state = moodCorrectionReducer(state, { type: "open" });
    expect(state.draftPrimaryEmotion).toBe(original.primaryEmotion);
    expect(isMoodCorrectionDirty(state)).toBe(false);

    state = moodCorrectionReducer(state, { type: "choose-primary", emotion: "calm" });
    state = moodCorrectionReducer(state, { type: "toggle-secondary", mood: "playful" });
    state = moodCorrectionReducer(state, { type: "toggle-secondary", mood: "nostalgic" });
    expect(state.draftSecondaryMoods).toEqual(["bright", "playful", "nostalgic"]);
    const atLimit = moodCorrectionReducer(state, { type: "toggle-secondary", mood: "warm" });
    expect(atLimit).toBe(state);
    expect(isMoodCorrectionDirty(state)).toBe(true);

    state = moodCorrectionReducer(state, { type: "apply" });
    expect(state.currentMood).toEqual({
      ...original,
      primaryEmotion: "calm",
      secondaryMoods: ["bright", "playful", "nostalgic"],
    });
    expect(moodResultSchema.parse(state.currentMood)).toEqual(state.currentMood);
    expect(state.currentMood.explanation).toBe(original.explanation);
    expect(state.currentMood.confidence).toBe(original.confidence);
    expect(state.corrected).toBe(true);
    expect(state.editorOpen).toBe(false);
  });

  it("keeps unknown original tags available and lets the user remove them", () => {
    const original = { ...MOOD_EXAMPLES[1], secondaryMoods: ["unlisted original tag"] };
    let state = moodCorrectionReducer(createMoodCorrectionState(original), { type: "open" });
    expect(state.draftSecondaryMoods).toEqual(["unlisted original tag"]);
    state = moodCorrectionReducer(state, { type: "toggle-secondary", mood: "unlisted original tag" });
    expect(state.draftSecondaryMoods).toEqual([]);
  });

  it("resets a correction to the original reading", () => {
    let state = moodCorrectionReducer(createMoodCorrectionState(MOOD_EXAMPLES[0]), { type: "open" });
    state = moodCorrectionReducer(state, { type: "choose-primary", emotion: "sad" });
    state = moodCorrectionReducer(state, { type: "apply" });
    expect(state.currentMood.primaryEmotion).toBe("sad");
    state = moodCorrectionReducer(state, { type: "reset" });
    expect(state.currentMood).toEqual(MOOD_EXAMPLES[0]);
    expect(state.corrected).toBe(false);
  });

  it("uses precisely the five shared primary choices and never invokes analysis", () => {
    expect(PRIMARY_EMOTIONS).toEqual(["happy", "sad", "calm", "energetic", "romantic"]);
    const state = moodCorrectionReducer(createMoodCorrectionState(MOOD_EXAMPLES[0]), { type: "open" });
    expect(state).not.toHaveProperty("analysis");
  });
});
