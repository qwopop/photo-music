import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  MOOD_EXAMPLES,
  moodResultJsonSchema,
  moodResultSchema,
  PRIMARY_EMOTIONS,
  type MoodResult,
  type PrimaryEmotion,
} from "./index";

const valid: MoodResult = {
  primaryEmotion: "calm",
  secondaryMoods: ["nostalgic", "dreamy", "quiet anticipation"],
  explanation: "The soft evening light suggests a calm atmosphere.",
  confidence: 0.5,
};
const fields = ["primaryEmotion", "secondaryMoods", "explanation", "confidence"] as const;

describe("mood contract", () => {
  it("exports the fixed primary enum and schema-derived TypeScript shape", () => {
    expect(PRIMARY_EMOTIONS).toEqual(["happy", "sad", "calm", "energetic", "romantic"]);
    expectTypeOf<PrimaryEmotion>().toEqualTypeOf<"happy" | "sad" | "calm" | "energetic" | "romantic">();
    expectTypeOf<MoodResult>().toEqualTypeOf<z.infer<typeof moodResultSchema>>();
    expectTypeOf<MoodResult>().toEqualTypeOf<{
      primaryEmotion: PrimaryEmotion;
      secondaryMoods: string[];
      explanation: string;
      confidence: number;
    }>();
    expectTypeOf<MoodResult["primaryEmotion"]>().toEqualTypeOf<PrimaryEmotion>();
  });

  it.each(MOOD_EXAMPLES)("accepts the synthetic $primaryEmotion example unchanged", (example) => {
    expect(moodResultSchema.parse(example)).toEqual(example);
  });

  it("covers every primary emotion, empty/three-tag arrays, and confidence endpoints in fixtures", () => {
    expect(new Set(MOOD_EXAMPLES.map(({ primaryEmotion }) => primaryEmotion))).toEqual(new Set(PRIMARY_EMOTIONS));
    expect(MOOD_EXAMPLES.some(({ secondaryMoods }) => secondaryMoods.length === 0)).toBe(true);
    expect(MOOD_EXAMPLES.some(({ secondaryMoods }) => secondaryMoods.length === 3)).toBe(true);
    expect(MOOD_EXAMPLES.some(({ confidence }) => confidence === 0)).toBe(true);
    expect(MOOD_EXAMPLES.some(({ confidence }) => confidence === 1)).toBe(true);
    for (const { explanation } of MOOD_EXAMPLES) expect(explanation).toMatch(/suggest/);
  });

  it("accepts free-form secondary tags and preserves case, spaces, and valid text", () => {
    const input = { ...valid, secondaryMoods: [" Nostalgic ", "DREAMY", "quiet anticipation"], explanation: "  Soft light suggests calm.  " };
    expect(moodResultSchema.parse(input)).toEqual(input);
    expect(moodResultSchema.parse(valid)).toEqual(valid);
  });

  it.each(fields)("requires %s, with no inferred default", (field) => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[field];
    expect(moodResultSchema.safeParse(missing).success).toBe(false);
    expect(moodResultSchema.safeParse({ ...valid, [field]: undefined }).success).toBe(false);
  });

  it.each(fields)("rejects null %s", (field) => {
    expect(moodResultSchema.safeParse({ ...valid, [field]: null }).success).toBe(false);
  });

  it.each([
    ["primaryEmotion", 1], ["primaryEmotion", true],
    ["secondaryMoods", "dreamy"], ["secondaryMoods", {}], ["secondaryMoods", [1]],
    ["secondaryMoods", [null]], ["secondaryMoods", [true]],
    ["explanation", 1], ["explanation", ["calm"]],
    ["confidence", "0.5"], ["confidence", true], ["confidence", {}],
  ])("rejects wrong type %s=%j without coercion", (field, value) => {
    expect(moodResultSchema.safeParse({ ...valid, [field as string]: value }).success).toBe(false);
  });

  it.each(["neutral", "Happy", "CALM", " calm ", ""])("rejects unsupported/case-mismatched primary %j", (primaryEmotion) => {
    expect(moodResultSchema.safeParse({ ...valid, primaryEmotion }).success).toBe(false);
  });

  it.each([0, 1, 2, 3])("accepts %i secondary tags", (count) => {
    expect(moodResultSchema.safeParse({ ...valid, secondaryMoods: ["dreamy", "nostalgic", "quiet anticipation"].slice(0, count) }).success).toBe(true);
  });

  it("rejects four secondary tags", () => {
    expect(moodResultSchema.safeParse({ ...valid, secondaryMoods: ["a", "b", "c", "d"] }).success).toBe(false);
  });

  it.each(["", " ", "\t\n\r", "\u00a0\u2003"])("rejects empty/blank text %j in both string fields", (blank) => {
    expect(moodResultSchema.safeParse({ ...valid, secondaryMoods: [blank] }).success).toBe(false);
    expect(moodResultSchema.safeParse({ ...valid, explanation: blank }).success).toBe(false);
  });

  it.each([1, 40])("accepts the %i-character secondary-tag boundary", (length) => {
    const secondaryMoods = ["x".repeat(length)];
    expect(moodResultSchema.parse({ ...valid, secondaryMoods }).secondaryMoods).toEqual(secondaryMoods);
  });

  it("rejects a 41-character tag", () => {
    expect(moodResultSchema.safeParse({ ...valid, secondaryMoods: ["x".repeat(41)] }).success).toBe(false);
  });

  it.each([1, 500])("accepts the %i-character explanation boundary", (length) => {
    const explanation = "x".repeat(length);
    expect(moodResultSchema.parse({ ...valid, explanation }).explanation).toBe(explanation);
  });

  it("rejects a 501-character explanation", () => {
    expect(moodResultSchema.safeParse({ ...valid, explanation: "x".repeat(501) }).success).toBe(false);
  });

  it("uses the installed Zod string-length convention without normalization", () => {
    // Zod 4.6.6 counts Unicode code points (unlike String.length's UTF-16
    // units), matching standard JSON Schema minLength/maxLength semantics.
    const input = { ...valid, secondaryMoods: ["🙂".repeat(40)], explanation: "🙂".repeat(500) };
    expect(moodResultSchema.parse(input)).toEqual(input);
    expect(moodResultSchema.safeParse({ ...valid, secondaryMoods: ["🙂".repeat(41)] }).success).toBe(false);
    expect(moodResultSchema.safeParse({ ...valid, explanation: "🙂".repeat(501) }).success).toBe(false);
  });

  it.each([0, Number.MIN_VALUE, 0.5, 1 - Number.EPSILON, 1])("accepts finite confidence boundary/value %j", (confidence) => {
    expect(moodResultSchema.parse({ ...valid, confidence }).confidence).toBe(confidence);
  });

  it.each([-Number.MIN_VALUE, -0.1, 1 + Number.EPSILON, 1.1, NaN, Infinity, -Infinity])("rejects invalid confidence %s", (confidence) => {
    expect(moodResultSchema.safeParse({ ...valid, confidence }).success).toBe(false);
  });

  it("rejects unknown properties rather than stripping them", () => {
    expect(moodResultSchema.safeParse({ ...valid, providerMetadata: "extra" }).success).toBe(false);
    expect(moodResultSchema.safeParse({ ...valid, colors: ["#ffffff"] }).success).toBe(false);
  });

  it.each([undefined, null, "calm", [], 1])("rejects a non-object result %j", (input) => {
    expect(moodResultSchema.safeParse(input).success).toBe(false);
  });
});

describe("generated mood JSON Schema", () => {
  it("is deterministic, JSON-serializable, and generated from the actual Zod source", () => {
    expect(moodResultJsonSchema).toEqual(z.toJSONSchema(moodResultSchema));
    expect(JSON.parse(JSON.stringify(moodResultJsonSchema))).toEqual(moodResultJsonSchema);
    expect(moodResultJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("requires exactly four fields and forbids unknown fields and defaults", () => {
    expect(moodResultJsonSchema.type).toBe("object");
    expect(moodResultJsonSchema.required).toEqual([...fields]);
    expect(Object.keys(moodResultJsonSchema.properties ?? {})).toEqual([...fields]);
    expect(moodResultJsonSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(moodResultJsonSchema)).not.toContain('"default"');
  });

  it("retains the enum, count, nonblank-string and numeric bounds", () => {
    const properties = moodResultJsonSchema.properties!;
    expect(properties.primaryEmotion).toEqual({ type: "string", enum: [...PRIMARY_EMOTIONS] });
    expect(properties.secondaryMoods).toEqual({
      type: "array", maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 40, pattern: "\\S" },
    });
    expect(properties.explanation).toEqual({ type: "string", minLength: 1, maxLength: 500, pattern: "\\S" });
    expect(properties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
    // The JSON Schema pattern must reject blank text while accepting a tag with
    // spaces inside it; it is not an enum or normalization instruction.
    expect(new RegExp("\\S").test("quiet anticipation")).toBe(true);
    expect(new RegExp("\\S").test("\t \n")).toBe(false);
  });
});
