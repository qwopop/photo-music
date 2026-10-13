import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { analyzePhotoMood, createClaudeVisionClient, MOOD_PROMPT, VisionError, type VisionClient } from "./index";

const sampleJpeg = readFileSync(new URL("../upload/fixtures/sample.jpg", import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/response-${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const KEY = "sk-ant-test-key-for-vitest";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fake fetch that replays `replies` in order (the last one repeats) and records requests. */
function fakeFetch(...replies: Reply[]) {
  const captured: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies[Math.min(captured.length, replies.length) - 1];
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, captured };
}

const ok = (name = "end-turn"): Reply => ({ body: fixture(name) });

function run(replies: Reply[], timeoutMs?: number) {
  const { fetch, captured } = fakeFetch(...replies);
  const client = createClaudeVisionClient({ fetch, timeoutMs });
  return { result: analyzePhotoMood(sampleJpeg, client), captured };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VisionError);
  return (error as VisionError).code;
}

beforeEach(() => {
  vi.stubEnv("VISION_API_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createClaudeVisionClient", () => {
  it("imports and builds without a key, a network or any environment variable", () => {
    vi.stubEnv("VISION_API_KEY", "");
    expect(() => createClaudeVisionClient()).not.toThrow();
  });

  it("sends one well-formed request to the Messages API", async () => {
    const { result, captured } = run([ok()]);
    expect((await result).primaryEmotion).toBe("calm");

    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request.method).toBe("POST");
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");

    const body = request.body;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    const config = body.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(config.effort).toBe("low");
    expect(config.format.type).toBe("json_schema");
    expect(config.format.schema.type).toBe("object");
    expect(config.format.schema.additionalProperties).toBe(false);
    expect(Object.keys(config.format.schema.properties as object).sort()).toEqual([
      "confidence",
      "explanation",
      "primaryEmotion",
      "secondaryMoods",
    ]);
    expect([...(config.format.schema.required as string[])].sort()).toEqual([
      "confidence",
      "explanation",
      "primaryEmotion",
      "secondaryMoods",
    ]);

    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools", "budget_tokens", "system"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    const messages = body.messages as { role: string; content: { type: string; source?: Record<string, string>; text?: string }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.map((block) => block.type)).toEqual(["image", "text"]);
    const image = messages[0].content[0].source!;
    expect(image.type).toBe("base64");
    expect(image.media_type).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(messages[0].content[1].text).toBe(MOOD_PROMPT);
    expect(JSON.stringify(body)).not.toMatch(/prefill|assistant/);
  });

  it("contains nothing from the caller apart from the image", async () => {
    const { result, captured } = run([ok()]);
    await result;
    const text = JSON.stringify(captured[0].body);
    expect(text.replace(/"data":"[^"]*"/, '"data":"<image>"')).not.toMatch(/sample|\.jpg|upload|127\.0\.0\.1/i);
    expect(Object.keys(captured[0].headers).sort().join()).not.toMatch(/forwarded|cookie|authorization/);
  });

  it.each([
    ["a text block alone", "end-turn"],
    ["a text block after a thinking block", "with-thinking"],
    ["a text block after a fallback block", "with-fallback"],
  ])("returns the mood JSON from %s", async (_, name) => {
    const { result } = run([ok(name)]);
    expect(await result).toEqual({
      primaryEmotion: "calm",
      secondaryMoods: ["quiet", "soft light"],
      explanation: "The soft evening light suggests a calm atmosphere.",
      confidence: 0.7,
    });
  });

  it.each([
    ["refusal", "refusal", "VISION_REFUSED"],
    ["max_tokens with cut-off JSON", "max-tokens", "VISION_BAD_RESPONSE"],
    ["text that is not JSON", "not-json", "VISION_BAD_RESPONSE"],
    ["no text block", "no-text", "VISION_BAD_RESPONSE"],
    ["empty content", "empty-content", "VISION_BAD_RESPONSE"],
  ])("maps %s to %s without requesting again", async (_, name, code) => {
    const { result, captured } = run([ok(name)]);
    expect(await codeOf(result)).toBe(code);
    expect(captured).toHaveLength(1);
  });

  it.each([
    ["primaryEmotion neutral", { ...MOOD_EXAMPLES[0], primaryEmotion: "neutral" }],
    ["confidence missing", { primaryEmotion: "calm", secondaryMoods: [], explanation: "x" }],
    ["confidence 1.2", { ...MOOD_EXAMPLES[0], confidence: 1.2 }],
    ["four secondary tags", { ...MOOD_EXAMPLES[0], secondaryMoods: ["a", "b", "c", "d"] }],
    ["a 501-character explanation", { ...MOOD_EXAMPLES[0], explanation: "x".repeat(501) }],
    ["an extra field", { ...MOOD_EXAMPLES[0], extra: 1 }],
  ])("rejects JSON with %s as VISION_BAD_RESPONSE", async (_, answer) => {
    const message = fixture("end-turn");
    message.content = [{ type: "text", text: JSON.stringify(answer) }];
    const { result, captured } = run([{ body: message }]);
    expect(await codeOf(result)).toBe("VISION_BAD_RESPONSE");
    expect(captured).toHaveLength(1);
  });

  describe("HTTP failures", () => {
    it.each([401, 403])("maps %i to VISION_NOT_CONFIGURED and does not retry", async (status) => {
      const { result, captured } = run([{ status, body: { type: "error", error: { type: "authentication_error", message: "bad key" } } }]);
      expect(await codeOf(result)).toBe("VISION_NOT_CONFIGURED");
      expect(captured).toHaveLength(1);
    });

    it.each([400, 404, 408, 409, 413, 422])("maps %i to VISION_UNAVAILABLE and does not retry", async (status) => {
      const { result, captured } = run([{ status, body: { type: "error", error: { type: "invalid_request_error", message: "no" } } }]);
      expect(await codeOf(result)).toBe("VISION_UNAVAILABLE");
      expect(captured).toHaveLength(1);
    });

    it.each([429, 500, 529])("maps %i to VISION_UNAVAILABLE after exactly one retry", async (status) => {
      const { result, captured } = run([{ status, body: { type: "error", error: { type: "api_error", message: "busy" } } }]);
      expect(await codeOf(result)).toBe("VISION_UNAVAILABLE");
      expect(captured).toHaveLength(2);
    });

    it("succeeds when the retry after a 529 succeeds", async () => {
      const { result, captured } = run([{ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "x" } } }, ok()]);
      expect((await result).primaryEmotion).toBe("calm");
      expect(captured).toHaveLength(2);
    });

    it("retries a connection failure once", async () => {
      const { result, captured } = run([new TypeError("fetch failed")]);
      expect(await codeOf(result)).toBe("VISION_UNAVAILABLE");
      expect(captured).toHaveLength(2);
    });

    it("recovers from one connection failure", async () => {
      const { result, captured } = run([new TypeError("fetch failed"), ok()]);
      expect((await result).confidence).toBe(0.7);
      expect(captured).toHaveLength(2);
    });

    it("ignores a huge retry-after and a forced x-should-retry", async () => {
      const started = Date.now();
      const { result, captured } = run([
        { status: 429, headers: { "retry-after": "86400", "retry-after-ms": "86400000" }, body: { type: "error", error: { message: "x" } } },
      ]);
      expect(await codeOf(result)).toBe("VISION_UNAVAILABLE");
      expect(captured).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(5000);

      const forced = run([{ status: 400, headers: { "x-should-retry": "true" }, body: { type: "error", error: { message: "x" } } }]);
      expect(await codeOf(forced.result)).toBe("VISION_UNAVAILABLE");
      expect(forced.captured).toHaveLength(1);
    });

    it("gives up on a provider that never answers, after one retry", async () => {
      const calls: number[] = [];
      const hang = (): Promise<Response> => {
        calls.push(1);
        return new Promise<Response>(() => {});
      };
      const client = createClaudeVisionClient({ fetch: hang, timeoutMs: 40 });
      expect(await codeOf(analyzePhotoMood(sampleJpeg, client))).toBe("VISION_UNAVAILABLE");
      expect(calls).toHaveLength(2);
    });
  });

  describe("configuration", () => {
    it.each([["unset", undefined], ["empty", ""], ["blank", "   "]])("makes no request when VISION_API_KEY is %s", async (_, value) => {
      if (value === undefined) vi.stubEnv("VISION_API_KEY", undefined as unknown as string);
      else vi.stubEnv("VISION_API_KEY", value);
      const { result, captured } = run([ok()]);
      expect(await codeOf(result)).toBe("VISION_NOT_CONFIGURED");
      expect(captured).toHaveLength(0);
    });

    it("reads the key when the analysis runs, not when the client is created", async () => {
      vi.stubEnv("VISION_API_KEY", "");
      const { fetch, captured } = fakeFetch(ok());
      const client = createClaudeVisionClient({ fetch });
      vi.stubEnv("VISION_API_KEY", "sk-ant-late-key");
      await analyzePhotoMood(sampleJpeg, client);
      expect(captured[0].headers["x-api-key"]).toBe("sk-ant-late-key");
    });
  });

  describe("nothing leaks", () => {
    const SENTINEL = "SENTINEL-LEAK-7f3a";

    function stubAmbient() {
      vi.stubEnv("ANTHROPIC_API_KEY", `${SENTINEL}-api-key`);
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", `${SENTINEL}-token`);
      vi.stubEnv("ANTHROPIC_BASE_URL", `https://${SENTINEL.toLowerCase()}.example`);
      vi.stubEnv("ANTHROPIC_LOG", "debug");
      vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", `Authorization: Bearer ${SENTINEL}-custom\nx-api-key: ${SENTINEL}-custom-key`);
    }

    function spyConsole() {
      return (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    }

    it("ignores the SDK's own environment variables and sends only VISION_API_KEY", async () => {
      stubAmbient();
      const spies = spyConsole();
      const { result, captured } = run([ok()]);
      await result;
      expect(new URL(captured[0].url).origin).toBe("https://api.anthropic.com");
      expect(captured[0].headers["x-api-key"]).toBe(KEY);
      expect(captured[0].headers).not.toHaveProperty("authorization");
      expect(JSON.stringify(captured[0])).not.toContain(SENTINEL);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ["a 401", { status: 401 }],
      ["a 400", { status: 400 }],
      ["a 529", { status: 529 }],
      ["a refusal", { status: 200, refusal: true }],
      ["bad model output", { status: 200, output: true }],
    ])("keeps sentinels out of the error and the console for %s", async (_, options) => {
      stubAmbient();
      const spies = spyConsole();
      let reply: Reply;
      if ("refusal" in options) {
        reply = { body: { ...fixture("refusal"), content: [{ type: "text", text: `${SENTINEL}-refusal` }] } };
      } else if ("output" in options) {
        const message = fixture("end-turn");
        message.content = [{ type: "text", text: `{"primaryEmotion":"${SENTINEL}-output"}` }];
        reply = { body: message };
      } else {
        reply = {
          status: options.status,
          body: { type: "error", request_id: `${SENTINEL}-req`, error: { type: "api_error", message: `${SENTINEL}-message` } },
        };
      }
      const { result } = run([reply]);
      const error = await result.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(VisionError);
      const visible = [(error as Error).message, String(error), JSON.stringify(error), (error as Error).name].join("\n");
      expect(visible).not.toContain(SENTINEL);
      expect(visible).not.toContain(KEY);
      expect((error as Error).cause).toBeUndefined();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it("keeps the key out of the error when the connection fails", async () => {
      const failure = new TypeError(`fetch failed for ${KEY}`);
      const { result } = run([failure]);
      const error = (await result.then(() => undefined, (e: unknown) => e)) as VisionError;
      expect(`${error.message}${String(error)}${JSON.stringify(error)}`).not.toContain(KEY);
      expect(error.cause).toBeUndefined();
    });
  });
});

describe("a hand-written fake client", () => {
  it("is enough to test the analyzer", async () => {
    const client: VisionClient = { analyze: async () => MOOD_EXAMPLES[1] };
    expect(await analyzePhotoMood(sampleJpeg, client)).toEqual(MOOD_EXAMPLES[1]);
  });
});
