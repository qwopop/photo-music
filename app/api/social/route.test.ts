import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../../../lib/mood";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  client: { generate: vi.fn() },
  create: vi.fn(),
  SocialError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

vi.mock("../../../lib/social", () => ({
  generateSocialContent: mocks.generate,
  createClaudeSocialClient: mocks.create,
  SocialError: mocks.SocialError,
}));

import { POST } from "./route";

const body = {
  mood: MOOD_EXAMPLES[0],
  featuredTrack: { title: "One track", artists: ["Artist"] },
};

describe("POST /api/social", () => {
  beforeEach(() => {
    mocks.generate.mockReset();
    mocks.create.mockReset().mockReturnValue(mocks.client);
  });

  it("returns 400 and no-store for invalid JSON or body", async () => {
    const invalidJson = await POST(new Request("http://localhost/api/social", { method: "POST", body: "{" }));
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.headers.get("cache-control")).toBe("no-store");

    mocks.generate.mockRejectedValue(new mocks.SocialError("SOCIAL_INVALID_INPUT"));
    const invalidBody = await POST(new Request("http://localhost/api/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, unexpected: true }),
    }));
    expect(invalidBody.status).toBe(400);
    expect(mocks.generate).toHaveBeenCalledWith({ ...body, unexpected: true }, mocks.client);
  });

  it("returns generated content with no-store", async () => {
    mocks.generate.mockResolvedValue({ captions: [], hashtags: [], storyText: "" });
    const response = await POST(new Request("http://localhost/api/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ captions: [], hashtags: [], storyText: "" });
  });

  it("returns generic provider errors without exception text", async () => {
    mocks.generate.mockRejectedValue(new Error("private provider body"));
    const response = await POST(new Request("http://localhost/api/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(JSON.stringify(json)).not.toContain("private provider body");
  });
});
