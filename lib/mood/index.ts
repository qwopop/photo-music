import { z } from "zod";

/** Fixed primary choices; secondary mood tags are deliberately free-form. */
export const PRIMARY_EMOTIONS = ["happy", "sad", "calm", "energetic", "romantic"] as const;
const primaryEmotionSchema = z.enum(PRIMARY_EMOTIONS);

export type PrimaryEmotion = z.infer<typeof primaryEmotionSchema>;

const secondaryMoodSchema = z.string().min(1).max(40).regex(/\S/, "A mood tag must contain a non-whitespace character.");
const explanationSchema = z.string().min(1).max(500).regex(/\S/, "An explanation must contain a non-whitespace character.");

/** Plain shared data contract; no coercion, normalization, defaults, or runtime settings. */
export const moodResultSchema = z.strictObject({
  primaryEmotion: primaryEmotionSchema,
  secondaryMoods: z.array(secondaryMoodSchema).max(3),
  explanation: explanationSchema,
  confidence: z.number().min(0).max(1),
});

export type MoodResult = z.infer<typeof moodResultSchema>;

/** Standard draft-2020-12 JSON Schema from the same source, not a second shape. */
export const moodResultJsonSchema = z.toJSONSchema(moodResultSchema);

export { MOOD_EXAMPLES } from "./examples";
