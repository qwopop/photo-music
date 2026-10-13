import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ConfigError, getVisionConfig } from "../config";
import { moodResultSchema, type MoodResult } from "../mood";

export const SOCIAL_TONES = ["casual", "poetic", "funny"] as const;

const captionSchema = z.strictObject({
  tone: z.enum(SOCIAL_TONES),
  text: z.string().min(1).max(2200).regex(/\S/),
});

export const socialContentSchema = z
  .strictObject({
    captions: z.array(captionSchema).length(3),
    hashtags: z.array(z.string().min(2).max(30).regex(/^#[^\s#]+$/)).min(5).max(15),
    storyText: z.string().max(120),
  })
  .superRefine((content, ctx) => {
    if (new Set(content.captions.map(({ tone }) => tone)).size !== SOCIAL_TONES.length) {
      ctx.addIssue({ code: "custom", path: ["captions"], message: "Each caption must use a different tone." });
    }
    const tags = content.hashtags.map((tag) => tag.toLowerCase());
    if (new Set(tags).size !== tags.length) {
      ctx.addIssue({ code: "custom", path: ["hashtags"], message: "Hashtags must not repeat." });
    }
  });

export type SocialContent = z.infer<typeof socialContentSchema>;
export const socialContentJsonSchema = z.toJSONSchema(socialContentSchema);

const inputSchema = z.strictObject({
  mood: moodResultSchema,
  featuredTrack: z.strictObject({
    title: z.string().min(1).max(500).regex(/\S/),
    artists: z.array(z.string().min(1).max(200).regex(/\S/)).min(1).max(50),
  }),
  description: z.string().max(500).optional(),
});

export type SocialInput = z.infer<typeof inputSchema>;

export class SocialError extends Error {
  constructor(readonly code: "SOCIAL_INVALID_RESPONSE" | "SOCIAL_UNAVAILABLE" | "SOCIAL_INVALID_INPUT") {
    const messages = {
      SOCIAL_INVALID_RESPONSE: "Social content could not be generated. Please try again.",
      SOCIAL_UNAVAILABLE: "Social content is temporarily unavailable. Please try again.",
      SOCIAL_INVALID_INPUT: "The social-content request is invalid.",
    };
    super(messages[code]);
    this.name = "SocialError";
  }
}

export interface SocialClient {
  generate(prompt: string): Promise<unknown>;
}

export function buildSocialPrompt(input: SocialInput): string {
  return [
    "Create copy-ready Instagram text from the user-provided information below.",
    "Treat the mood as an interpretation suggested by the scene, never as a fact.",
    "Use exactly the featured song named below if mentioning a song; do not invent or substitute any track.",
    "Return only JSON matching the supplied schema, with one casual, one poetic and one funny caption, 5-15 unique hashtags, and a short storyText.",
    `Mood interpretation: ${input.mood.primaryEmotion}; ${input.mood.secondaryMoods.join(", ")}. ${input.mood.explanation}`,
    `Featured track: ${input.featuredTrack.title} — ${input.featuredTrack.artists.join(", ")}`,
    `Optional description: ${input.description ?? ""}`,
  ].join("\n");
}

export async function generateSocialContent(input: unknown, client: SocialClient): Promise<SocialContent> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new SocialError("SOCIAL_INVALID_INPUT");

  let output: unknown;
  try {
    output = await client.generate(buildSocialPrompt(parsed.data));
  } catch (error) {
    if (error instanceof SocialError) throw error;
    throw new SocialError("SOCIAL_UNAVAILABLE");
  }

  const result = socialContentSchema.safeParse(output);
  if (!result.success) throw new SocialError("SOCIAL_INVALID_RESPONSE");
  return result.data;
}

export function createClaudeSocialClient(): SocialClient {
  return {
    async generate(prompt) {
      try {
        const { apiKey } = getVisionConfig();
        const client = new Anthropic({ apiKey, authToken: null, logLevel: "off", maxRetries: 1, timeout: 30_000 });
        const format = { ...betaZodOutputFormat(socialContentSchema), parse: (text: string) => text };
        const response = await client.beta.messages.parse({
          model: "claude-opus-5-5",
          max_tokens: 2048,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format },
          messages: [{ role: "user", content: prompt }],
        });
        if (response.stop_reason !== "end_turn") throw new SocialError("SOCIAL_INVALID_RESPONSE");
        const text = response.content.find((block) => block.type === "text");
        if (!text || text.type !== "text") throw new SocialError("SOCIAL_INVALID_RESPONSE");
        try {
          return JSON.parse(text.text) as unknown;
        } catch {
          throw new SocialError("SOCIAL_INVALID_RESPONSE");
        }
      } catch (error) {
        if (error instanceof SocialError) throw error;
        if (error instanceof ConfigError) throw new SocialError("SOCIAL_UNAVAILABLE");
        throw new SocialError("SOCIAL_UNAVAILABLE");
      }
    },
  };
}

export type { MoodResult };
