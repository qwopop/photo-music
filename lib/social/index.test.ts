import { describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { generateSocialContent, SocialClient, socialContentSchema } from "./index";

const input = {
  mood: MOOD_EXAMPLES[2],
  featuredTrack: { title: "Only Returned Track", artists: ["Provider Artist"] },
  description: "A quiet shore at dusk.",
};

const valid = {
  captions: [
    { tone: "casual", text: "An evening worth keeping." },
    { tone: "poetic", text: "The dusk settles softly on the water." },
    { tone: "funny", text: "My camera said, 'one more sunset'." },
  ],
  hashtags: ["#sunset", "#calm", "#evening", "#music", "#mood"],
  storyText: "A little calm for the evening.",
};

describe("social content generation", () => {
  it("validates the provider response and keeps the one returned song in the prompt", async () => {
    const generate = vi.fn<(...args: [string]) => Promise<typeof valid>>(async () => valid);
    const client: SocialClient = { generate };
    expect(await generateSocialContent(input, client)).toEqual(valid);
    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("Only Returned Track — Provider Artist");
    expect(prompt).toContain("interpretation suggested");
    expect(prompt).toContain(input.description);
    expect(prompt).not.toContain("image");
    expect(prompt).not.toContain("user id");
    expect(prompt).not.toContain("email");
  });

  it.each([
    { ...valid, captions: valid.captions.slice(0, 2) },
    { ...valid, hashtags: Array.from({ length: 40 }, (_, i) => `#tag${i}`) },
    { ...valid, hashtags: ["#" + "a".repeat(30), ...valid.hashtags.slice(1)] },
    { ...valid, hashtags: ["nosharp", ...valid.hashtags.slice(1)] },
    { ...valid, hashtags: ["#SUNSET", ...valid.hashtags] },
    { ...valid, captions: [{ tone: "casual", text: "x".repeat(2201) }, ...valid.captions.slice(1)] },
    { ...valid, captions: [{ tone: "casual", text: "" }, ...valid.captions.slice(1)] },
    { ...valid, storyText: "x".repeat(121) },
  ])("rejects malformed or incomplete output", async (output) => {
    const client: SocialClient = { generate: async () => output };
    await expect(generateSocialContent(input, client)).rejects.toMatchObject({ code: "SOCIAL_INVALID_RESPONSE" });
  });

  it("maps unknown provider failures to a stable safe error", async () => {
    const client: SocialClient = { generate: async () => { throw new Error("provider key and response body"); } };
    await expect(generateSocialContent(input, client)).rejects.toMatchObject({ code: "SOCIAL_UNAVAILABLE" });
    try {
      await generateSocialContent(input, client);
    } catch (error) {
      expect((error as Error).message).not.toContain("provider key");
      expect((error as Error).message).not.toContain("response body");
    }
  });

  it("exports a JSON schema", () => {
    expect(() => socialContentSchema.parse({ ...valid, extra: true })).toThrow();
    expect(socialContentSchema.toJSONSchema().type).toBe("object");
  });

  it("rejects invalid request fields before calling the client", async () => {
    const client: SocialClient = { generate: vi.fn(async () => valid) };
    await expect(generateSocialContent({ ...input, extra: true } as never, client)).rejects.toMatchObject({
      code: "SOCIAL_INVALID_INPUT",
    });
    expect(client.generate).not.toHaveBeenCalled();
  });
});
