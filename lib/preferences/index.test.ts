import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES, GENRES, PREFERENCE_LENGTHS, parsePreferences, preferencesSchema, serializePreferences,
} from "./index";

const valid = DEFAULT_PREFERENCES;
const parse = (q: string) => parsePreferences(new URLSearchParams(q));

describe("preferencesSchema", () => {
  it("accepts the defaults", () => {
    expect(preferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(true);
    expect(PREFERENCE_LENGTHS).toEqual([5, 10, 20, 30]);
    expect(GENRES.length).toBeGreaterThanOrEqual(12);
  });
  it.each([
    ["unknown genre", { genres: ["nope"] }],
    ["duplicate genre", { genres: ["pop", "pop"] }],
    ["unknown language", { languages: ["klingon"] }],
    ["unknown situation", { situation: "flying" }],
    ["length 0", { length: 0 }],
    ["length 15", { length: 15 }],
    ["length string", { length: "10" }],
    ["length 10.5", { length: 10.5 }],
    ["11 artists", { artists: Array.from({ length: 11 }, (_, i) => `a${i}`) }],
    ["101-char artist", { artists: ["a".repeat(101)] }],
    ["blank artist", { artists: ["  "] }],
    ["case-insensitive duplicate", { artists: ["Abba", "ABBA"] }],
    ["unknown property", { extra: 1 }],
  ])("rejects %s", (_n, patch) => {
    expect(preferencesSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("accepts boundaries", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `a${i}`);
    expect(preferencesSchema.safeParse({ ...valid, artists: ten }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...valid, artists: ["a".repeat(100)] }).success).toBe(true);
    for (const length of PREFERENCE_LENGTHS) expect(preferencesSchema.safeParse({ ...valid, length }).success).toBe(true);
  });
});

describe("serializePreferences", () => {
  it("leaves out defaults", () => {
    expect(serializePreferences(DEFAULT_PREFERENCES).toString()).toBe("");
    expect(serializePreferences({ ...valid, length: 20, situation: "driving" }).toString()).toBe("situation=driving&length=20");
  });
  it.each(["a, b", "AC/DC & Co", "#1 = 100%", "Ünal Çağlar 日本語", "Björk 🎵", "50 Cent%20"])("round trips %s", (name) => {
    const p = { ...valid, artists: [name, "Other"], genres: ["jazz" as const] };
    const text = serializePreferences(p).toString();
    expect(parse(text)).toEqual(p);
    expect(parse("?" + text)).toEqual(p);
  });
});

describe("parsePreferences", () => {
  it("parses the example", () => {
    expect(parse("genre=jazz&genre=lo-fi&artist=Nina%20Simone&language=english&situation=driving&length=20")).toEqual({
      genres: ["jazz", "lo-fi"], artists: ["Nina Simone"], languages: ["english"], situation: "driving", length: 20,
    });
  });
  it("falls back to defaults on invalid values", () => {
    expect(parse("length=99&genre=nope&situation=flying&foo=bar")).toEqual(DEFAULT_PREFERENCES);
    expect(parse("")).toEqual(DEFAULT_PREFERENCES);
    for (const l of ["15", "abc", "10.5", "", "1e1", " 10", "0"]) {
      expect(parse(`length=${encodeURIComponent(l)}`).length).toBe(10);
    }
  });
  it("dedupes ids and uses the first scalar value", () => {
    const p = parse("genre=pop&genre=pop&genre=x&language=french&language=french&situation=relaxing&situation=driving&length=5&length=30");
    expect(p).toMatchObject({ genres: ["pop"], languages: ["french"], situation: "relaxing", length: 5 });
  });
  it("cleans artists", () => {
    const many = Array.from({ length: 12 }, (_, i) => `artist=n${i}`).join("&");
    expect(parse(`artist=%20%20&artist=%20Abba%20&artist=ABBA&artist=${"a".repeat(101)}&artist=`).artists).toEqual(["Abba"]);
    expect(parse(many).artists).toHaveLength(10);
    expect(parse(`artist=${"a".repeat(100)}`).artists).toHaveLength(1);
  });
  it("never throws on junk", () => {
    expect(() => parse("%E0%A4%A&genre=%00&artist=%ff&situation[]=1")).not.toThrow();
  });
});
