import { describe, expect, it } from "vitest";
import { PRIMARY_EMOTIONS, type MoodResult } from "../mood";
import { DEFAULT_PREFERENCES, GENRES, SITUATIONS, type Preferences } from "../preferences";
import {
  EMOTION_MAPPINGS,
  SITUATION_MAPPINGS,
  SOURCE_WEIGHTS,
  buildSearchCriteria,
  type SearchCriteria,
} from "./index";

const mood = (primaryEmotion: MoodResult["primaryEmotion"], secondaryMoods: string[] = [], confidence = 0.8): MoodResult => ({
  primaryEmotion, secondaryMoods, explanation: "x", confidence,
});
const prefs = (p: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...p });
const w = (c: SearchCriteria) => Object.fromEntries(c.genres.map((g) => [g.genre, g.weight]));
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("base mapping table", () => {
  const expected = {
    happy: [0.75, 110, 140, ["pop", "indie", "electronic"], ["upbeat", "feel good"]],
    sad: [0.25, 60, 90, ["folk", "indie", "ambient"], ["melancholic", "sad"]],
    calm: [0.2, 60, 90, ["ambient", "lo-fi", "classical", "jazz"], ["calm", "peaceful"]],
    energetic: [0.9, 125, 170, ["electronic", "rock", "hip-hop"], ["energetic", "high energy"]],
    romantic: [0.4, 70, 100, ["r-and-b", "jazz", "pop"], ["romantic", "love"]],
  } as const;
  for (const e of PRIMARY_EMOTIONS) {
    it(e, () => {
      const [energy, minBpm, maxBpm, genres, keywords] = expected[e];
      const c = buildSearchCriteria(mood(e), DEFAULT_PREFERENCES);
      expect(c.energy).toBe(energy);
      expect(c.tempo).toEqual({ minBpm, maxBpm });
      expect(c.keywords).toEqual(keywords);
      expect([...c.genres.map((g) => g.genre)].sort()).toEqual([...genres].sort());
      for (const g of c.genres) near(g.weight, 1 / genres.length);
      expect(c.weights).toEqual({ mood: 1, preferences: 0, situation: 0 });
      expect(EMOTION_MAPPINGS[e].energy).toBe(energy);
    });
  }
});

describe("situation table", () => {
  const expected = {
    studying: [-0.15, ["lo-fi", "ambient", "classical"], "focus"],
    "walking-at-night": [-0.05, ["electronic", "ambient", "indie"], "night"],
    relaxing: [-0.2, ["ambient", "jazz", "lo-fi"], "relax"],
    driving: [0.15, ["rock", "pop", "electronic"], "road trip"],
  } as const;
  for (const s of SITUATIONS) {
    it(s, () => {
      const [change, genres, keyword] = expected[s];
      expect(SITUATION_MAPPINGS[s]).toEqual({ energyChange: change, genres, keyword });
      const c = buildSearchCriteria(mood("happy"), prefs({ situation: s }));
      near(c.energy, 0.75 + change);
      const shift = Math.round(change * 100);
      expect(c.tempo).toEqual({ minBpm: 110 + shift, maxBpm: 140 + shift });
      expect(c.keywords).toEqual(["upbeat", "feel good", keyword]);
    });
  }
  it("clamps energy and checks boundaries", () => {
    const a = buildSearchCriteria(mood("calm"), prefs({ situation: "relaxing" }));
    expect(a.energy).toBe(0);
    expect(a.tempo).toEqual({ minBpm: 40, maxBpm: 70 });
    const b = buildSearchCriteria(mood("energetic"), prefs({ situation: "driving" }));
    expect(b.energy).toBe(1);
    expect(b.tempo).toEqual({ minBpm: 140, maxBpm: 185 });
  });
});

describe("weights", () => {
  it("constants", () => expect(SOURCE_WEIGHTS).toEqual({ mood: 0.6, preferences: 0.3, situation: 0.1 }));
  it("no preferences", () => {
    const c = buildSearchCriteria(mood("happy"), DEFAULT_PREFERENCES);
    for (const g of c.genres) near(g.weight, 1 / 3);
  });
  it("mood and situation", () => {
    const c = buildSearchCriteria(mood("happy"), prefs({ situation: "studying" }));
    near(c.weights.mood, 6 / 7);
    near(c.weights.situation, 1 / 7);
    expect(c.weights.preferences).toBe(0);
    const g = w(c);
    near(g.pop, 6 / 21);
    near(g["lo-fi"], 1 / 21);
    near(g.indie, 6 / 21);
  });
  it("preferences only (with mood)", () => {
    const c = buildSearchCriteria(mood("happy"), prefs({ genres: ["jazz", "latin"] }));
    near(c.weights.mood, 2 / 3);
    near(c.weights.preferences, 1 / 3);
    const g = w(c);
    near(g.pop, 2 / 9);
    near(g.jazz, 1 / 6);
    near(g.latin, 1 / 6);
  });
  it("all three sources, genre named by all three", () => {
    const c = buildSearchCriteria(mood("happy"), prefs({ genres: ["pop", "rock"], situation: "driving" }));
    expect(c.weights).toEqual({ mood: 0.6, preferences: 0.3, situation: 0.1 });
    const g = w(c);
    near(g.pop, 0.2 + 0.15 + 0.1 / 3);
    near(g.rock, 0.15 + 0.1 / 3);
    near(g.electronic, 0.2 + 0.2 / 3);
    near(g.indie, 0.2);
    expect(c.genres[0].genre).toBe("pop");
    near(c.genres.reduce((s, x) => s + x.weight, 0), 1);
  });
  it("sorts ties by genre name", () => {
    const c = buildSearchCriteria(mood("happy"), DEFAULT_PREFERENCES);
    expect(c.genres.map((g) => g.genre)).toEqual(["electronic", "indie", "pop"]);
  });
});

describe("preferences passthrough", () => {
  it("passes artists and languages without changing anything else", () => {
    const base = buildSearchCriteria(mood("sad"), DEFAULT_PREFERENCES);
    const c = buildSearchCriteria(mood("sad"), prefs({ artists: ["B", "a"], languages: ["french", "english"] }));
    expect(c.artists).toEqual(["B", "a"]);
    expect(c.languages).toEqual(["french", "english"]);
    expect(c.weights).toEqual(base.weights);
    expect({ ...c, artists: [], languages: [] }).toEqual(base);
    expect(base.artists).toEqual([]);
    expect(base.languages).toEqual([]);
  });
});

describe("keywords", () => {
  it("trims, lowercases, dedupes", () => {
    const c = buildSearchCriteria(mood("calm", ["Calm", "  Dreamy ", "dreamy"]), DEFAULT_PREFERENCES);
    expect(c.keywords).toEqual(["calm", "peaceful", "dreamy"]);
  });
  it("accepts a 40-character tag", () => {
    const tag = "A".repeat(40);
    expect(buildSearchCriteria(mood("sad", [tag]), DEFAULT_PREFERENCES).keywords).toContain("a".repeat(40));
  });
  it("3 tags with driving give 6 keywords, situation last", () => {
    const c = buildSearchCriteria(mood("happy", ["a", "b", "c"]), prefs({ situation: "driving" }));
    expect(c.keywords).toEqual(["upbeat", "feel good", "a", "b", "c", "road trip"]);
  });
  it("cap of 8 keeps the situation keyword and drops last tags", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const c = buildSearchCriteria(mood("happy", many), prefs({ situation: "driving" }));
    expect(c.keywords).toHaveLength(8);
    expect(c.keywords).toEqual(["upbeat", "feel good", "a", "b", "c", "d", "e", "road trip"]);
    expect(buildSearchCriteria(mood("happy", many), DEFAULT_PREFERENCES).keywords).toHaveLength(8);
  });
  it("tags never change genres, energy or tempo", () => {
    const a = buildSearchCriteria(mood("happy"), DEFAULT_PREFERENCES);
    const b = buildSearchCriteria(mood("happy", ["rock", "x"]), DEFAULT_PREFERENCES);
    expect({ ...b, keywords: [] }).toEqual({ ...a, keywords: [] });
  });
});

describe("confidence, purity", () => {
  it("ignores confidence", () => {
    const [a, b, c] = [0, 0.5, 1].map((x) => buildSearchCriteria(mood("romantic", [], x), DEFAULT_PREFERENCES));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
  it("is deterministic, does not mutate, shares nothing", () => {
    const m = Object.freeze({ ...mood("happy", ["x"]), secondaryMoods: Object.freeze(["x"]) as unknown as string[] });
    const p = Object.freeze({
      ...prefs({ genres: ["jazz"], artists: ["A"], languages: ["english"], situation: "driving" }),
    });
    Object.freeze(p.genres);
    Object.freeze(p.artists);
    Object.freeze(p.languages);
    const first = buildSearchCriteria(m, p);
    const snapshot = structuredClone(first);
    first.genres.length = 0;
    first.keywords.push("zzz");
    first.tempo.minBpm = 1;
    first.artists.push("q");
    const second = buildSearchCriteria(m, p);
    expect(second).toEqual({ ...snapshot });
    expect(EMOTION_MAPPINGS.happy.keywords).toEqual(["upbeat", "feel good"]);
    expect(EMOTION_MAPPINGS.happy.tempo).toEqual({ minBpm: 110, maxBpm: 140 });
  });
});

describe("every emotion x every situation", () => {
  for (const e of PRIMARY_EMOTIONS) {
    for (const s of [null, ...SITUATIONS]) {
      for (const g of [[], ["jazz", "latin"]] as Preferences["genres"][]) {
        it(`${e} + ${s} + ${g.length} genres`, () => {
          const c = buildSearchCriteria(mood(e, ["one", "two", "three"]), prefs({ situation: s, genres: g }));
          near(c.genres.reduce((sum, x) => sum + x.weight, 0), 1);
          for (const x of c.genres) expect(GENRES).toContain(x.genre);
          for (let i = 1; i < c.genres.length; i++) expect(c.genres[i - 1].weight + 1e-12).toBeGreaterThanOrEqual(c.genres[i].weight);
          expect(c.energy).toBeGreaterThanOrEqual(0);
          expect(c.energy).toBeLessThanOrEqual(1);
          expect(Number.isInteger(c.tempo.minBpm) && Number.isInteger(c.tempo.maxBpm)).toBe(true);
          expect(c.tempo.minBpm).toBeGreaterThanOrEqual(40);
          expect(c.tempo.minBpm).toBeLessThan(c.tempo.maxBpm);
          expect(c.tempo.maxBpm).toBeLessThanOrEqual(200);
          expect(c.keywords.length).toBeLessThanOrEqual(8);
          expect(new Set(c.keywords).size).toBe(c.keywords.length);
          near(c.weights.mood + c.weights.preferences + c.weights.situation, 1);
        });
      }
    }
  }
});
