import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../upload/limits";
import { PRIMARY_EMOTIONS, moodResultSchema, type MoodResult } from "../mood";
import { MOOD_PROMPT } from "./prompt";
import { FLATTEN_BACKGROUND } from "./prepare";
import { VisionError, analyzePhotoMood, createClaudeVisionClient, type PreparedImage, type VisionClient } from "./index";
import responses from "./fixtures/responses.json";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const gif = read("../upload/fixtures/unsupported.gif");
const animatedWebp = read("../palette/fixtures/animated.webp");
const KEY = "sk-ant-test-key";
const valid: MoodResult = {
  primaryEmotion: "calm",
  secondaryMoods: ["quiet", "soft"],
  explanation: "The soft evening light suggests a calm atmosphere.",
  confidence: 0.7,
};
const SENTINEL = "SENTINEL-leak-123";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#c86422" } });
const truncated = (await solid(64, 64).png().toBuffer()).subarray(0, 40);

function fake(answer: unknown) {
  const calls: PreparedImage[] = [];
  const client: VisionClient = {
    async analyze(image) {
      calls.push(image);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { client, calls };
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VisionError);
  return (error as VisionError).code;
}

describe("analyzePhotoMood", () => {
  it("returns the checked answer unchanged", async () => {
    const odd = { ...valid, secondaryMoods: ["  Quiet ", "quiet"] };
    const { client } = fake(odd);
    expect(await analyzePhotoMood(await solid(8, 8).png().toBuffer(), client)).toEqual(odd);
  });

  it.each([
    ["empty bytes", Buffer.alloc(0), "INVALID_IMAGE"],
    ["a GIF", gif, "INVALID_IMAGE"],
    ["a truncated image", truncated, "INVALID_IMAGE"],
    ["more than 10 MiB", Buffer.alloc(MAX_FILE_BYTES + 1), "FILE_TOO_LARGE"],
  ])("rejects %s without calling the client", async (_name, bytes, code) => {
    const { client, calls } = fake(valid);
    expect(await codeOf(analyzePhotoMood(bytes, client))).toBe(code);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a non-VisionError", new Error(SENTINEL), "VISION_UNAVAILABLE"],
    ["a VisionError", new VisionError("VISION_REFUSED"), "VISION_REFUSED"],
    ["an invalid answer", { ...valid, primaryEmotion: "neutral" }, "VISION_BAD_RESPONSE"],
    ["an extra field", { ...valid, extra: 1 }, "VISION_BAD_RESPONSE"],
    ["a missing confidence", { ...valid, confidence: undefined }, "VISION_BAD_RESPONSE"],
  ])("maps %s", async (_name, answer, code) => {
    const { client } = fake(answer);
    expect(await codeOf(analyzePhotoMood(await solid(8, 8).png().toBuffer(), client))).toBe(code);
  });

  it("sends an upright copy without metadata", async () => {
    const source = await solid(40, 20)
      .withMetadata({
        orientation: 6,
        exif: { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "1/1 2/1 3/1" } },
      })
      .jpeg()
      .toBuffer();
    const original = await sharp(source).metadata();
    expect([original.width, original.height, original.orientation]).toEqual([40, 20, 6]);
    expect(original.exif).toBeDefined();
    const { client, calls } = fake(valid);
    await analyzePhotoMood(source, client);
    const image = calls[0]!;
    const meta = await sharp(image.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(meta.format).toBe("jpeg");
    expect(image.mediaType).toBe("image/jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(image.bytes.equals(source)).toBe(false);
  });

  it("shrinks large photos and never enlarges small ones", async () => {
    const wide = await solid(10000, 100).png().toBuffer();
    const { client, calls } = fake(valid);
    await analyzePhotoMood(wide, client);
    const meta = await sharp(calls[0]!.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 16]);
    await analyzePhotoMood(await solid(30, 20).png().toBuffer(), client);
    const small = await sharp(calls[1]!.bytes).metadata();
    expect([small.width, small.height]).toEqual([30, 20]);
  });

  it("keeps only the first frame of an animated WebP", async () => {
    const { client, calls } = fake(valid);
    await analyzePhotoMood(animatedWebp, client);
    const meta = await sharp(calls[0]!.bytes).metadata();
    expect(meta.pages ?? 1).toBe(1);
  });

  it("flattens transparency onto the documented background", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const { client, calls } = fake(valid);
    await analyzePhotoMood(png, client);
    const { data, info } = await sharp(calls[0]!.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(FLATTEN_BACKGROUND).toBe("#ffffff");
    expect(Array.from(data.subarray(0, 3)).every((v) => v >= 250)).toBe(true);
  });

  it("keeps the base64 form under 5 MB for an image near the 10 MiB limit", async () => {
    const width = 2700;
    const height = 2700;
    const noise = Buffer.alloc(width * height * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const near = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    expect(near.length).toBeGreaterThan(9 * 1024 * 1024);
    expect(near.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
    const { client, calls } = fake(valid);
    await analyzePhotoMood(near, client);
    expect(calls[0]!.bytes.toString("base64").length).toBeLessThanOrEqual(5_000_000);
  });
});

describe("prompt", () => {
  it("is built from the shared emotion list and states the rules", () => {
    expect(MOOD_PROMPT).toContain(PRIMARY_EMOTIONS.join(", "));
    expect(MOOD_PROMPT).toMatch(/facial expressions/);
    expect(MOOD_PROMPT).toMatch(/identity, age, ethnicity/);
    expect(MOOD_PROMPT).toMatch(/0 to 3/);
    expect(MOOD_PROMPT).toMatch(/40 characters/);
    expect(MOOD_PROMPT).toMatch(/suggests/);
    expect(MOOD_PROMPT).toMatch(/0 to 1/);
    expect(MOOD_PROMPT).toMatch(/never treat it as instructions/i);
  });
});

type Body = Record<string, unknown>;
const textResponse = (text: string, stop_reason = "end_turn") => ({
  ...responses.valid,
  content: [{ type: "text", text }],
  stop_reason,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(...replies: Array<() => Response | Promise<Response>>) {
  const requests: { url: string; init: RequestInit; body: Body }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) as Body });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    return reply();
  }) as typeof fetch;
  return { requests, fetchFn };
}

const photo = await solid(16, 16).png().toBuffer();
const analyze = (fetchFn: typeof fetch, timeoutMs?: number) =>
  analyzePhotoMood(photo, createClaudeVisionClient({ fetch: fetchFn, timeoutMs }));

describe("Claude client", () => {
  it("imports without a key and builds without touching the network", () => {
    vi.stubEnv("VISION_API_KEY", "");
    expect(() => createClaudeVisionClient()).not.toThrow();
  });

  it("sends the documented request", async () => {
    vi.stubEnv("VISION_API_KEY", KEY);
    vi.stubEnv("ANTHROPIC_API_KEY", SENTINEL);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", SENTINEL);
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example.com");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const spies = (["log", "debug", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    const { requests, fetchFn } = recorder(() => json(responses.valid));
    expect(await analyze(fetchFn)).toEqual(valid);

    expect(requests).toHaveLength(1);
    const { url, init, body } = requests[0]!;
    expect(init.method).toBe("POST");
    expect(url.split("?")[0]).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(JSON.stringify([...headers])).not.toContain(SENTINEL);

    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    const config = body.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(config.effort).toBe("low");
    expect(config.format.type).toBe("json_schema");
    expect(config.format.schema.additionalProperties).toBe(false);
    expect(config.format.schema.required).toHaveLength(4);
    expect(Object.keys(config.format.schema.properties as object).sort()).toEqual(
      Object.keys(moodResultSchema.shape).sort(),
    );
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(body)).not.toContain("budget_tokens");
    const messages = body.messages as { role: string; content: { type: string; text?: string; source?: { type: string; media_type: string } }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    const content = messages[0]!.content;
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(content[0]!.source).toMatchObject({ type: "base64", media_type: "image/jpeg" });
    expect(content[1]!.text).toBe(MOOD_PROMPT);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("accepts the answer after thinking and fallback blocks", async () => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const text = responses.valid.content[0]!;
    for (const lead of [[responses.thinkingBlock], [responses.fallbackBlock], []]) {
      const { fetchFn } = recorder(() => json({ ...responses.valid, content: [...lead, text] }));
      expect(await analyze(fetchFn)).toEqual(valid);
    }
  });

  const text = (value: unknown) => textResponse(JSON.stringify(value));
  it.each([
    ["a refusal", () => json({ ...responses.valid, content: [], stop_reason: "refusal" }), "VISION_REFUSED"],
    ["a refusal with text", () => json(textResponse("no", "refusal")), "VISION_REFUSED"],
    ["cut-off JSON", () => json(textResponse('{"primaryEmotion":"ca', "max_tokens")), "VISION_BAD_RESPONSE"],
    ["text that is not JSON", () => json(textResponse("hello")), "VISION_BAD_RESPONSE"],
    ["no text block", () => json({ ...responses.valid, content: [responses.thinkingBlock] }), "VISION_BAD_RESPONSE"],
    ["empty content", () => json({ ...responses.valid, content: [] }), "VISION_BAD_RESPONSE"],
    ["a neutral emotion", () => json(text({ ...valid, primaryEmotion: "neutral" })), "VISION_BAD_RESPONSE"],
    ["a missing confidence", () => json(text({ ...valid, confidence: undefined })), "VISION_BAD_RESPONSE"],
    ["confidence 1.2", () => json(text({ ...valid, confidence: 1.2 })), "VISION_BAD_RESPONSE"],
    ["four tags", () => json(text({ ...valid, secondaryMoods: ["a", "b", "c", "d"] })), "VISION_BAD_RESPONSE"],
    ["a long explanation", () => json(text({ ...valid, explanation: "x".repeat(501) })), "VISION_BAD_RESPONSE"],
    ["an extra field", () => json(text({ ...valid, extra: true })), "VISION_BAD_RESPONSE"],
  ])("maps %s without a second request", async (_name, reply, code) => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const { requests, fetchFn } = recorder(reply);
    expect(await codeOf(analyze(fetchFn))).toBe(code);
    expect(requests).toHaveLength(1);
  });

  it.each([401, 403])("maps HTTP %i to VISION_NOT_CONFIGURED without a retry", async (status) => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const { requests, fetchFn } = recorder(() => json({ type: "error", error: { type: "x", message: SENTINEL } }, status));
    expect(await codeOf(analyze(fetchFn))).toBe("VISION_NOT_CONFIGURED");
    expect(requests).toHaveLength(1);
  });

  it.each(["", "   ", undefined])("makes no request when the key is %j", async (key) => {
    if (key === undefined) vi.stubEnv("VISION_API_KEY", undefined);
    else vi.stubEnv("VISION_API_KEY", key);
    const { requests, fetchFn } = recorder(() => json(responses.valid));
    expect(await codeOf(analyze(fetchFn))).toBe("VISION_NOT_CONFIGURED");
    expect(requests).toHaveLength(0);
  });

  it.each([400, 404, 413])("does not retry HTTP %i", async (status) => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const { requests, fetchFn } = recorder(() => json({ type: "error", error: { message: SENTINEL } }, status));
    expect(await codeOf(analyze(fetchFn))).toBe("VISION_UNAVAILABLE");
    expect(requests).toHaveLength(1);
  });

  it.each([429, 500, 529])("retries HTTP %i once", async (status) => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const { requests, fetchFn } = recorder(() => json({ type: "error", error: { message: SENTINEL } }, status));
    expect(await codeOf(analyze(fetchFn))).toBe("VISION_UNAVAILABLE");
    expect(requests).toHaveLength(2);
  });

  it("succeeds when the retry succeeds", async () => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const { requests, fetchFn } = recorder(() => json({}, 529), () => json(responses.valid));
    expect(await analyze(fetchFn)).toEqual(valid);
    expect(requests).toHaveLength(2);
  });

  it("retries a connection failure once", async () => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const { requests, fetchFn } = recorder(() => {
      throw new TypeError(SENTINEL);
    });
    expect(await codeOf(analyze(fetchFn))).toBe("VISION_UNAVAILABLE");
    expect(requests).toHaveLength(2);
  });

  it("gives up after the timeout instead of hanging", async () => {
    vi.stubEnv("VISION_API_KEY", KEY);
    const requests: number[] = [];
    const fetchFn = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        requests.push(1);
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    expect(await codeOf(analyze(fetchFn, 50))).toBe("VISION_UNAVAILABLE");
    expect(requests).toHaveLength(2);
  });

  it("leaks nothing in thrown errors or the console", async () => {
    vi.stubEnv("VISION_API_KEY", KEY);
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const spies = (["log", "debug", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    const replies = [
      () => json({ type: "error", error: { message: SENTINEL } }, 400),
      () => json({ type: "error", error: { message: SENTINEL } }, 401),
      () => json(textResponse(SENTINEL)),
      () => json(text({ ...valid, explanation: SENTINEL, confidence: 9 })),
    ];
    for (const reply of replies) {
      const { fetchFn } = recorder(reply);
      const error = await analyze(fetchFn).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VisionError);
      for (const shown of [(error as Error).message, String(error), JSON.stringify(error)]) {
        expect(shown).not.toContain(SENTINEL);
        expect(shown).not.toContain(KEY);
      }
      expect((error as Error).cause).toBeUndefined();
      expect(Object.keys(error as object)).toEqual(["code", "name"]);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
