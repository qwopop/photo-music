import { afterEach, describe, expect, it, vi } from "vitest";
import { PaletteError } from "../palette";
import { MOOD_EXAMPLES, moodResultSchema } from "../mood";
import { TemporaryUploadStore, type ConsumedUpload } from "../upload/store";
import { VisionError, type VisionErrorCode } from "../vision";
import { AnalysisRateLimiter } from "./rate-limit";
import { handleAnalysisRequest, type AnalysisDependencies } from "./index";

const image: ConsumedUpload = {
  bytes: Buffer.from("synthetic test image"),
  mimeType: "image/jpeg",
  size: 19,
};
const palette = { colors: ["#abcdef", "#123456", "#234567", "#345678", "#456789", "#56789a"], brightness: 0.4 };
const mood = MOOD_EXAMPLES[0];

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function dependencies(overrides: Partial<AnalysisDependencies> = {}): AnalysisDependencies {
  return {
    consumeUpload: vi.fn(() => image),
    extractPalette: vi.fn(async () => palette),
    analyze: vi.fn(async () => mood),
    limiter: new AnalysisRateLimiter(),
    ...overrides,
  };
}

async function responseBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/analyze request handling", () => {
  it("returns exactly the validated mood and the image palette without private upload data", async () => {
    const deps = dependencies();
    const response = await handleAnalysisRequest(request('{"upload":"opaque-handle"}'), deps);
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["mood", "palette"]);
    expect(moodResultSchema.parse(body.mood)).toEqual(mood);
    expect(body.palette).toEqual(palette);
    expect(JSON.stringify(body)).not.toContain("opaque-handle");
    expect(deps.consumeUpload).toHaveBeenCalledWith("opaque-handle");
    expect(deps.extractPalette).toHaveBeenCalledWith(image.bytes);
    expect(deps.analyze).toHaveBeenCalledWith(image.bytes);
  });

  it.each([
    ["a non-JSON content type", "{}", { "Content-Type": "text/plain" }],
    ["malformed JSON", "{", {}],
    ["an array body", "[]", {}],
    ["a missing upload", "{}", {}],
    ["a non-string upload", '{"upload":3}', {}],
    ["an extra field", '{"upload":"x","other":1}', {}],
    ["a body over 1 KiB", JSON.stringify({ upload: "x".repeat(1012) }), {}],
  ])("returns 400 for %s before consuming or analyzing", async (_label, body, headers) => {
    const deps = dependencies();
    const response = await handleAnalysisRequest(request(body, headers), deps);
    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.consumeUpload).not.toHaveBeenCalled();
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("rejects a streaming body over 1 KiB even without a Content-Length header", async () => {
    const body = JSON.stringify({ upload: "x".repeat(1012) });
    const requestWithStream = new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const deps = dependencies();
    expect((await handleAnalysisRequest(requestWithStream, deps)).status).toBe(400);
    expect(deps.consumeUpload).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly 1 KiB", async () => {
    const body = '{"upload":"x"}'.padEnd(1024, " ");
    const deps = dependencies();
    expect((await handleAnalysisRequest(request(body), deps)).status).toBe(200);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for empty and unknown handles without calling the analyzer", async () => {
    const store = new TemporaryUploadStore();
    const deps = dependencies({ consumeUpload: (uploadId) => store.consume(uploadId) });
    for (const uploadId of ["", "unknown-handle"]) {
      const response = await handleAnalysisRequest(request(JSON.stringify({ upload: uploadId })), deps);
      expect(response.status).toBe(404);
      expect(await responseBody(response)).toMatchObject({ error: { code: "UPLOAD_NOT_FOUND" } });
    }
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("returns 404 for expired handles without calling the analyzer", async () => {
    let now = 0;
    const store = new TemporaryUploadStore({ now: () => now, ttlMs: 100 });
    const { id } = store.put({ bytes: image.bytes, mimeType: "image/jpeg" });
    now = 100;
    const deps = dependencies({ consumeUpload: (uploadId) => store.consume(uploadId) });
    const response = await handleAnalysisRequest(request(JSON.stringify({ upload: id })), deps);
    expect(response.status).toBe(404);
    expect(await responseBody(response)).toMatchObject({ error: { code: "UPLOAD_NOT_FOUND" } });
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("does not analyze or consume an already-used handle a second time", async () => {
    const store = new TemporaryUploadStore();
    const { id } = store.put({ bytes: image.bytes, mimeType: "image/jpeg" });
    const deps = dependencies({ consumeUpload: (uploadId) => store.consume(uploadId) });
    expect((await handleAnalysisRequest(request(JSON.stringify({ upload: id })), deps)).status).toBe(200);
    expect((await handleAnalysisRequest(request(JSON.stringify({ upload: id })), deps)).status).toBe(404);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
  });

  it("leaves a handle available when rate limited, then consumes it after the window", async () => {
    let now = 0;
    const store = new TemporaryUploadStore({ now: () => now, ttlMs: 60_000 });
    const { id } = store.put({ bytes: image.bytes, mimeType: "image/jpeg" });
    const limiter = new AnalysisRateLimiter({ maxRequests: 1, windowMs: 1000, now: () => now });
    const deps = dependencies({
      consumeUpload: (uploadId) => store.consume(uploadId),
      limiter,
      now: () => now,
    });

    const ip = { "X-Forwarded-For": "192.0.2.42" };
    expect((await handleAnalysisRequest(request('{"upload":"unknown"}', ip), deps)).status).toBe(404);
    const limited = await handleAnalysisRequest(request(JSON.stringify({ upload: id }), ip), deps);
    expect(limited.status).toBe(429);
    expect(deps.analyze).not.toHaveBeenCalled();

    now = 1000;
    expect((await handleAnalysisRequest(request(JSON.stringify({ upload: id }), ip), deps)).status).toBe(200);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
  });

  it("consumes a valid handle before palette and analyzer work, including when later steps fail", async () => {
    const consumeUpload = vi.fn(() => image);
    const extractPalette = vi.fn(async () => { throw new PaletteError("NO_VISIBLE_PIXELS"); });
    const analyze = vi.fn(async () => mood);
    const response = await handleAnalysisRequest(
      request('{"upload":"single-use"}'),
      dependencies({ consumeUpload, extractPalette, analyze }),
    );
    expect(response.status).toBe(422);
    expect(consumeUpload).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_IMAGE", 415],
    ["FILE_TOO_LARGE", 413],
    ["NO_VISIBLE_PIXELS", 422],
  ] as const)("maps palette error %s to %i and does not call the analyzer", async (code, status) => {
    const deps = dependencies({
      extractPalette: vi.fn(async () => { throw new PaletteError(code); }),
    });
    const response = await handleAnalysisRequest(request('{"upload":"x"}'), deps);
    expect(response.status).toBe(status);
    expect((await responseBody(response)).error).toMatchObject({ code });
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_IMAGE", 415],
    ["FILE_TOO_LARGE", 413],
    ["VISION_REFUSED", 422],
    ["VISION_BAD_RESPONSE", 502],
    ["VISION_UNAVAILABLE", 503],
    ["VISION_NOT_CONFIGURED", 503],
  ] as [VisionErrorCode, number][])("maps vision error %s to %i", async (code, status) => {
    const deps = dependencies({ analyze: vi.fn(async () => { throw new VisionError(code); }) });
    const response = await handleAnalysisRequest(request('{"upload":"x"}'), deps);
    expect(response.status).toBe(status);
    expect((await responseBody(response)).error).toMatchObject({ code });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("maps unexpected errors to a safe 500 without leaking their messages", async () => {
    const deps = dependencies({ analyze: vi.fn(async () => { throw new Error("private provider response"); }) });
    const response = await handleAnalysisRequest(request('{"upload":"x"}'), deps);
    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({
      error: { code: "ANALYSIS_FAILED", message: "Photo analysis failed. Please try again." },
    });
  });

  it("does not consume an upload when rate limited and isolates requests by forwarded IP", async () => {
    const consumeUpload = vi.fn(() => image);
    const limiter = new AnalysisRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const deps = dependencies({ consumeUpload, limiter });
    await handleAnalysisRequest(request('{"upload":"first"}', { "X-Forwarded-For": "203.0.113.4, 10.0.0.1" }), deps);
    const limited = await handleAnalysisRequest(
      request('{"upload":"second"}', { "X-Forwarded-For": "203.0.113.4, 10.0.0.2" }),
      deps,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(consumeUpload).toHaveBeenCalledTimes(1);
    expect((await handleAnalysisRequest(request('{"upload":"third"}', { "X-Forwarded-For": "203.0.113.5" }), deps)).status).toBe(200);
  });

  it("uses one shared rate-limit bucket for absent and blank forwarded headers", async () => {
    const limiter = new AnalysisRateLimiter({ maxRequests: 1 });
    const deps = dependencies({ limiter });
    expect((await handleAnalysisRequest(request('{"upload":"first"}'), deps)).status).toBe(200);
    const response = await handleAnalysisRequest(request('{"upload":"second"}', { "X-Forwarded-For": " , 192.0.2.9" }), deps);
    expect(response.status).toBe(429);
  });
});
