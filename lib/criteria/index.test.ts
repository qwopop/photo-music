import { describe, expect, it } from "vitest";
import { buildSearchCriteria, EMOTION_MAPPING, SITUATION_MAPPING, SOURCE_WEIGHTS } from "./index";
import { PRIMARY_EMOTIONS, moodResultSchema, type MoodResult } from "../mood";
import { DEFAULT_PREFERENCES, GENRES, SITUATIONS, type Preferences } from "../preferences";

const mood = (over: Partial<MoodResult> = {}): MoodResult => ({
  primaryEmotion: "happy", secondaryMoods: [], explanation: "x", confidence: 0.8, ...over,
});
const prefs = (over: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...over });
const weightOf = (c: ReturnType<typeof buildSearchCriteria>, g: string) =>
  c.genres.find((x) => x.genre === g)?.weight ?? 0;

describe("base mapping", () => {
  const table = {
    happy: [0.75, 110, 140, ["pop", "indie", "electronic"], ["upbeat", "feel good"]],
    sad: [0.25, 60, 90, ["folk", "indie", "ambient"], ["melancholic", "sad"]],
    calm: [0.2, 60, 90, ["ambient", "lo-fi", "classical", "jazz"], ["calm", "peaceful"]],
    energetic: [0.9, 125, 170, ["electronic", "rock", "hip-hop"], ["energetic", "high energy"]],
    romantic: [0.4, 70, 100, ["r-and-b", "jazz", "pop"], ["romantic", "love"]],
  } as const;
  for (const e of PRIMARY_EMOTIONS) {
    it(e, () => {
      const [energy, min, max, genres, keywords] = table[e];
      const c = buildSearchCriteria(mood({ primaryEmotion: e }), prefs());
      expect(c.energy).toBeCloseTo(energy, 9);
      expect(c.tempo).toEqual({ minBpm: min, maxBpm: max });
      expect(c.genres.map((g) => g.genre).sort()).toEqual([...genres].sort());
      for (const g of c.genres) expect(g.weight).toBeCloseTo(1 / genres.length, 9);
      expect(c.keywords).toEqual(keywords);
      expect(c.weights).toEqual({ mood: 1, preferences: 0, situation: 0 });
      expect([...EMOTION_MAPPING[e].genres]).toEqual(genres);
    });
  }
});

describe("situations", () => {
  const table = {
    studying: [-0.15, -15, ["lo-fi", "ambient", "classical"], "focus"],
    "walking-at-night": [-0.05, -5, ["electronic", "ambient", "indie"], "night"],
    relaxing: [-0.2, -20, ["ambient", "jazz", "lo-fi"], "relax"],
    driving: [0.15, 15, ["rock", "pop", "electronic"], "road trip"],
  } as const;
  for (const s of SITUATIONS) {
    it(s, () => {
      const [change, shift, genres, keyword] = table[s];
      expect(SITUATION_MAPPING[s].energyChange).toBe(change);
      expect([...SITUATION_MAPPING[s].genres]).toEqual(genres);
      const c = buildSearchCriteria(mood({ primaryEmotion: "romantic" }), prefs({ situation: s }));
      expect(c.energy).toBeCloseTo(0.4 + change, 9);
      expect(c.tempo).toEqual({ minBpm: 70 + shift, maxBpm: 100 + shift });
      expect(c.keywords.at(-1)).toBe(keyword);
      expect(c.weights.mood).toBeCloseTo(6 / 7, 9);
      expect(c.weights.situation).toBeCloseTo(1 / 7, 9);
    });
  }
  it("boundaries", () => {
    const low = buildSearchCriteria(mood({ primaryEmotion: "calm" }), prefs({ situation: "relaxing" }));
    expect(low.energy).toBe(0);
    expect(low.tempo).toEqual({ minBpm: 40, maxBpm: 70 });
    const high = buildSearchCriteria(mood({ primaryEmotion: "energetic" }), prefs({ situation: "driving" }));
    expect(high.energy).toBe(1);
    expect(high.tempo).toEqual({ minBpm: 140, maxBpm: 185 });
  });
});

describe("weights", () => {
  it("constants", () => expect(SOURCE_WEIGHTS).toEqual({ mood: 0.6, preferences: 0.3, situation: 0.1 }));
  it("preferences only", () => {
    const c = buildSearchCriteria(mood(), prefs({ genres: ["rock", "jazz"] }));
    expect(c.weights.mood).toBeCloseTo(2 / 3, 9);
    expect(c.weights.preferences).toBeCloseTo(1 / 3, 9);
    expect(weightOf(c, "pop")).toBeCloseTo(2 / 9, 9);
    expect(weightOf(c, "rock")).toBeCloseTo(1 / 6, 9);
    expect(weightOf(c, "jazz")).toBeCloseTo(1 / 6, 9);
  });
  it("all three sources", () => {
    const c = buildSearchCriteria(mood(), prefs({ genres: ["rock"], situation: "driving" }));
    expect(c.weights.mood).toBeCloseTo(0.6, 9);
    expect(c.weights.preferences).toBeCloseTo(0.3, 9);
    expect(c.weights.situation).toBeCloseTo(0.1, 9);
    expect(weightOf(c, "rock")).toBeCloseTo(0.3 + 0.1 / 3, 9);
    expect(weightOf(c, "pop")).toBeCloseTo(0.2 + 0.1 / 3, 9);
    expect(weightOf(c, "electronic")).toBeCloseTo(0.2 + 0.1 / 3, 9);
    expect(weightOf(c, "indie")).toBeCloseTo(0.2, 9);
    expect(c.genres[0].genre).toBe("rock");
  });
  it("a genre named by all three", () => {
    const c = buildSearchCriteria(mood(), prefs({ genres: ["pop"], situation: "driving" }));
    expect(weightOf(c, "pop")).toBeCloseTo(0.2 + 0.3 + 0.1 / 3, 9);
  });
  it("sorts ties by name", () => {
    const c = buildSearchCriteria(mood(), prefs());
    expect(c.genres.map((g) => g.genre)).toEqual(["electronic", "indie", "pop"]);
  });
  it("artists and languages alone drop the preferences weight", () => {
    const c = buildSearchCriteria(mood(), prefs({ artists: ["A"], languages: ["french"] }));
    expect(c.weights).toEqual({ mood: 1, preferences: 0, situation: 0 });
    expect(c.artists).toEqual(["A"]);
    expect(c.languages).toEqual(["french"]);
  });
});

describe("keywords", () => {
  it("trims, lowercases, dedupes against emotion keywords", () => {
    const c = buildSearchCriteria(mood({ primaryEmotion: "calm", secondaryMoods: ["  Calm ", "Dreamy", "dreamy"] }), prefs());
    expect(c.keywords).toEqual(["calm", "peaceful", "dreamy"]);
  });
  it("40-character tag", () => {
    const tag = "A".repeat(40);
    expect(buildSearchCriteria(mood({ secondaryMoods: [tag] }), prefs()).keywords).toContain(tag.toLowerCase());
  });
  it("3 tags with driving: situation last", () => {
    const c = buildSearchCriteria(mood({ secondaryMoods: ["a", "b", "c"] }), prefs({ situation: "driving" }));
    expect(c.keywords).toEqual(["upbeat", "feel good", "a", "b", "c", "road trip"]);
  });
  it("cap of 8 keeps situation, drops last secondary", () => {
    const m = mood({ secondaryMoods: ["a", "b", "c", "d", "e", "f", "g"] });
    const c = buildSearchCriteria(m, prefs({ situation: "driving" }));
    expect(c.keywords).toHaveLength(8);
    expect(c.keywords.at(-1)).toBe("road trip");
    expect(c.keywords).not.toContain("g");
    expect(buildSearchCriteria(m, prefs()).keywords).toHaveLength(8);
  });
  it("secondary moods do not change genres, energy or tempo", () => {
    const a = buildSearchCriteria(mood(), prefs());
    const b = buildSearchCriteria(mood({ secondaryMoods: ["x", "y"] }), prefs());
    expect({ ...b, keywords: [] }).toEqual({ ...a, keywords: [] });
  });
});

describe("confidence and purity", () => {
  it("ignores confidence", () => {
    const [a, b, c] = [0, 0.5, 1].map((confidence) => buildSearchCriteria(mood({ confidence }), prefs()));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
  it("is deterministic, does not mutate frozen input, shares nothing", () => {
    const m = Object.freeze(mood({ secondaryMoods: Object.freeze(["a"]) as unknown as string[] }));
    const p = Object.freeze(prefs({
      genres: Object.freeze(["rock"]) as unknown as Preferences["genres"],
      artists: Object.freeze(["A"]) as unknown as string[],
      languages: Object.freeze(["french"]) as unknown as Preferences["languages"],
      situation: "driving",
    }));
    const one = buildSearchCriteria(m, p);
    expect(buildSearchCriteria(m, p)).toEqual(one);
    one.genres.length = 0;
    one.keywords.push("zzz");
    one.artists.push("B");
    one.tempo.minBpm = 0;
    const two = buildSearchCriteria(m, p);
    expect(two.genres.length).toBeGreaterThan(0);
    expect(two.keywords).not.toContain("zzz");
    expect(two.artists).toEqual(["A"]);
    expect(two.tempo.minBpm).toBe(125);
    expect(EMOTION_MAPPING.happy.minBpm).toBe(110);
  });
});

describe("every emotion x situation", () => {
  for (const e of PRIMARY_EMOTIONS) {
    for (const s of [null, ...SITUATIONS]) {
      it(`${e} + ${s}`, () => {
        const m = mood({ primaryEmotion: e, secondaryMoods: ["a", "b", "c"] });
        expect(moodResultSchema.safeParse(m).success).toBe(true);
        const c = buildSearchCriteria(m, prefs({ situation: s, genres: ["latin", "rock"] }));
        expect(c.genres.reduce((n, g) => n + g.weight, 0)).toBeCloseTo(1, 9);
        for (const g of c.genres) expect(GENRES).toContain(g.genre);
        for (let i = 1; i < c.genres.length; i++) expect(c.genres[i - 1].weight).toBeGreaterThanOrEqual(c.genres[i].weight - 1e-12);
        expect(c.energy).toBeGreaterThanOrEqual(0);
        expect(c.energy).toBeLessThanOrEqual(1);
        expect(Number.isInteger(c.tempo.minBpm) && Number.isInteger(c.tempo.maxBpm)).toBe(true);
        expect(c.tempo.minBpm).toBeGreaterThanOrEqual(40);
        expect(c.tempo.minBpm).toBeLessThan(c.tempo.maxBpm);
        expect(c.tempo.maxBpm).toBeLessThanOrEqual(200);
        expect(c.keywords.length).toBeLessThanOrEqual(8);
        expect(new Set(c.keywords).size).toBe(c.keywords.length);
        expect(c.weights.mood + c.weights.preferences + c.weights.situation).toBeCloseTo(1, 9);
      });
    }
  }
});
