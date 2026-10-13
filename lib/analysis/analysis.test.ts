import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../app/api/analyze/route";
import { moodResultSchema, type MoodResult } from "../mood";
import { extractPalette } from "../palette";
import { TemporaryUploadStore } from "../upload/store";
import { VisionError, type VisionErrorCode } from "../vision/errors";
import { handleAnalyze } from "./handler";
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS, RateLimiter } from "./rate-limit";

const jpeg = readFileSync(new URL("../upload/fixtures/sample.jpg", import.meta.url));
const gif = readFileSync(new URL("../upload/fixtures/unsupported.gif", import.meta.url));
const mood: MoodResult = { primaryEmotion: "calm", secondaryMoods: ["quiet"], explanation: "Soft light suggests calm.", confidence: 0.7 };

function setup(analyzeImpl?: (bytes: Buffer) => Promise<MoodResult>, limiterOptions = {}) {
  let time = 1_000_000;
  const now = () => time;
  const store = new TemporaryUploadStore({ now });
  const limiter = new RateLimiter({ now, ...limiterOptions });
  const analyze = vi.fn(analyzeImpl ?? (async () => mood));
  const deps = { analyze, consumeUpload: (id: string) => store.consume(id), limiter };
  const put = (bytes: Buffer = jpeg) => store.put({ bytes, mimeType: "image/jpeg" }).id;
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    handleAnalyze(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      deps,
    );
  return { analyze, put, call, advance: (ms: number) => (time += ms), store };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body;
}

describe("success", () => {
  it("returns mood and palette only", async () => {
    const { call, put } = setup();
    const handle = put();
    const response = await call({ upload: handle });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["mood", "palette"]);
    expect(moodResultSchema.safeParse(body.mood).success).toBe(true);
    expect(body.palette).toEqual(await extractPalette(jpeg));
    expect(body.palette.colors).toHaveLength(6);
    expect(text).not.toContain(handle);
  });
});

describe("request validation", () => {
  it.each([
    ["non-JSON", "not json"],
    ["array", "[]"],
    ["missing upload", "{}"],
    ["non-string upload", '{"upload":5}'],
    ["extra field", '{"upload":"a","x":1}'],
    ["over 1 KiB", JSON.stringify({ upload: "a".repeat(2000) })],
  ])("400 for %s without analyzing", async (_name, body) => {
    const { call, analyze } = setup();
    await expectError(await call(body), 400, "INVALID_REQUEST");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("400 for a wrong content type", async () => {
    const { analyze } = setup();
    const { call } = setup();
    const response = await handleAnalyze(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"upload":"a"}' }),
      { analyze, consumeUpload: () => undefined, limiter: new RateLimiter() },
    );
    await expectError(response, 400, "INVALID_REQUEST");
    void call;
  });

  it("405 with Allow for GET on the route and the handler", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    const { analyze } = setup();
    const viaHandler = await handleAnalyze(new Request("http://localhost/api/analyze"), { analyze, consumeUpload: () => undefined, limiter: new RateLimiter() });
    expect(viaHandler.status).toBe(405);
    expect(viaHandler.headers.get("allow")).toBe("POST");
  });

  it("route POST without a valid body gives 400 and reads no environment", async () => {
    const response = await POST(new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    await expectError(response, 400, "INVALID_REQUEST");
  });
});

describe("single-use handle", () => {
  it("second use, unknown, empty and expired handles give 404 with zero analyzer calls", async () => {
    const { call, put, analyze, advance } = setup();
    const handle = put();
    expect((await call({ upload: handle })).status).toBe(200);
    analyze.mockClear();
    await expectError(await call({ upload: handle }), 404, "UPLOAD_NOT_FOUND");
    await expectError(await call({ upload: "unknown" }), 404, "UPLOAD_NOT_FOUND");
    await expectError(await call({ upload: "" }), 404, "UPLOAD_NOT_FOUND");
    const expiring = put();
    advance(60 * 60 * 1000);
    await expectError(await call({ upload: expiring }), 404, "UPLOAD_NOT_FOUND");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("a very long handle never reaches the analyzer", async () => {
    const { call, analyze } = setup();
    // 10,000 characters also exceeds the 1 KiB body limit, so it is rejected as a bad body.
    await expectError(await call({ upload: "a".repeat(10_000) }), 400, "INVALID_REQUEST");
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe("error table", () => {
  const rows: [VisionErrorCode, number][] = [
    ["INVALID_IMAGE", 415],
    ["FILE_TOO_LARGE", 413],
    ["VISION_REFUSED", 422],
    ["VISION_BAD_RESPONSE", 502],
    ["VISION_UNAVAILABLE", 503],
    ["VISION_NOT_CONFIGURED", 503],
  ];
  it.each(rows)("%s maps to %i", async (code, status) => {
    const { call, put } = setup(async () => {
      throw new VisionError(code);
    });
    await expectError(await call({ upload: put() }), status, code);
  });

  it("any other error gives 500 ANALYSIS_FAILED without leaking", async () => {
    const { call, put } = setup(async () => {
      throw new Error("secret sk-ant-xyz provider text");
    });
    const body = await expectError(await call({ upload: put() }), 500, "ANALYSIS_FAILED");
    expect(JSON.stringify(body)).not.toContain("sk-ant");
  });

  it("invalid image bytes give 415 with no analyzer call", async () => {
    const { call, put, analyze } = setup();
    await expectError(await call({ upload: put(gif) }), 415, "INVALID_IMAGE");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("oversized image gives 413 with no analyzer call", async () => {
    const { call, put, analyze } = setup();
    await expectError(await call({ upload: put(Buffer.alloc(11 * 1024 * 1024)) }), 413, "FILE_TOO_LARGE");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("transparent image gives 422 NO_VISIBLE_PIXELS with no analyzer call", async () => {
    const { call, put, analyze } = setup();
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await expectError(await call({ upload: put(png) }), 422, "NO_VISIBLE_PIXELS");
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe("rate limit", () => {
  it("limits per IP, recovers after the window, and keeps the handle on 429", async () => {
    // Shorter window than the upload TTL, so the kept handle is still alive after it passes.
    const windowMs = 60_000;
    const { call, put, analyze, advance } = setup(undefined, { windowMs });
    const ip = { "x-forwarded-for": "1.1.1.1, 9.9.9.9" };
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) expect((await call({ upload: put() }, ip)).status).toBe(200);
    analyze.mockClear();
    const kept = put();
    const limited = await call({ upload: kept }, ip);
    await expectError(limited, 429, "RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number.isInteger(Number(limited.headers.get("retry-after")))).toBe(true);
    expect(analyze).not.toHaveBeenCalled();
    expect((await call({ upload: put() }, { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
    advance(windowMs + 1);
    expect((await call({ upload: kept }, ip)).status).toBe(200);
  });

  it("counts failed requests but not 400s", async () => {
    const { call } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) await call("bad");
    expect((await call({ upload: "missing" })).status).toBe(404);
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS - 1; i++) await call({ upload: "missing" });
    await expectError(await call({ upload: "missing" }), 429, "RATE_LIMITED");
  });

  it("shares one bucket without X-Forwarded-For, including blank", async () => {
    const { call } = setup();
    for (let i = 0; i < 5; i++) await call({ upload: "m" });
    for (let i = 0; i < 5; i++) await call({ upload: "m" }, { "x-forwarded-for": "  " });
    await expectError(await call({ upload: "m" }), 429, "RATE_LIMITED");
  });

  it("is bounded: rejects new IPs at the cap, drops expired entries first", () => {
    let time = 0;
    const limiter = new RateLimiter({ maxIps: 2, now: () => time });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(false);
    expect(limiter.check("a").allowed).toBe(true);
    time += RATE_LIMIT_WINDOW_MS + 1;
    expect(limiter.check("c").allowed).toBe(true);
  });
});
