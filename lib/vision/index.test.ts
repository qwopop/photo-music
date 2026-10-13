import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES, PRIMARY_EMOTIONS } from "../mood";
import { MAX_FILE_BYTES } from "../upload/limits";
import { analyzePhotoMood, MOOD_PROMPT, VisionError, type PreparedImage, type VisionClient } from "./index";
import { MAX_BASE64_BYTES, MAX_VISION_SIDE } from "./prepare";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const sampleJpeg = read("../upload/fixtures/sample.jpg");

function fakeClient(answer: unknown = MOOD_EXAMPLES[0]) {
  const images: PreparedImage[] = [];
  const client: VisionClient = {
    analyze: vi.fn(async (image: PreparedImage) => {
      images.push(image);
      return answer;
    }),
  };
  return { client, images, calls: () => vi.mocked(client.analyze).mock.calls.length };
}

async function prepared(bytes: Buffer): Promise<PreparedImage> {
  const { client, images } = fakeClient();
  await analyzePhotoMood(bytes, client);
  return images[0];
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VisionError);
  return (error as VisionError).code;
}

describe("analyzePhotoMood", () => {
  it("returns the checked answer unchanged", async () => {
    const answer = { primaryEmotion: "calm", secondaryMoods: [" Dreamy ", "dreamy"], explanation: "  Suggests calm.  ", confidence: 0 };
    const { client } = fakeClient(answer);
    expect(await analyzePhotoMood(sampleJpeg, client)).toEqual(answer);
  });

  it.each(MOOD_EXAMPLES.map((example) => [example.primaryEmotion, example]))("accepts the %s example", async (_, example) => {
    expect(await analyzePhotoMood(sampleJpeg, fakeClient(example).client)).toEqual(example);
  });

  it.each([
    ["empty bytes", () => Buffer.alloc(0), "INVALID_IMAGE"],
    ["a GIF", () => read("../upload/fixtures/unsupported.gif"), "INVALID_IMAGE"],
    ["a truncated image", () => sampleJpeg.subarray(0, Math.floor(sampleJpeg.length / 2)), "INVALID_IMAGE"],
    ["corrupt data", () => Buffer.from("not an image at all"), "INVALID_IMAGE"],
    ["more than 10 MiB", () => Buffer.alloc(MAX_FILE_BYTES + 1), "FILE_TOO_LARGE"],
  ])("rejects %s before calling the client", async (_, make, code) => {
    const { client, calls } = fakeClient();
    expect(await codeOf(analyzePhotoMood(make(), client))).toBe(code);
    expect(calls()).toBe(0);
  });

  it("maps a non-VisionError from the client to VISION_UNAVAILABLE without keeping its text", async () => {
    const client: VisionClient = { analyze: async () => { throw new Error("secret-sentinel"); } };
    const error = await analyzePhotoMood(sampleJpeg, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VisionError);
    expect((error as VisionError).code).toBe("VISION_UNAVAILABLE");
    expect(String(error) + JSON.stringify(error)).not.toContain("secret-sentinel");
    expect((error as Error).cause).toBeUndefined();
  });

  it("passes a VisionError from the client through by code", async () => {
    const client: VisionClient = { analyze: async () => { throw new VisionError("VISION_REFUSED"); } };
    expect(await codeOf(analyzePhotoMood(sampleJpeg, client))).toBe("VISION_REFUSED");
  });

  it.each([
    ["primaryEmotion neutral", { ...MOOD_EXAMPLES[0], primaryEmotion: "neutral" }],
    ["a missing confidence", { primaryEmotion: "calm", secondaryMoods: [], explanation: "ok" }],
    ["confidence 1.2", { ...MOOD_EXAMPLES[0], confidence: 1.2 }],
    ["four secondary tags", { ...MOOD_EXAMPLES[0], secondaryMoods: ["a", "b", "c", "d"] }],
    ["a 501-character explanation", { ...MOOD_EXAMPLES[0], explanation: "x".repeat(501) }],
    ["an extra field", { ...MOOD_EXAMPLES[0], extra: true }],
    ["a string", "calm"],
    ["null", null],
  ])("rejects an answer with %s as VISION_BAD_RESPONSE", async (_, answer) => {
    expect(await codeOf(analyzePhotoMood(sampleJpeg, fakeClient(answer).client))).toBe("VISION_BAD_RESPONSE");
  });

  it("has safe fixed messages and no cause", () => {
    const error = new VisionError("VISION_BAD_RESPONSE");
    expect(Object.keys(error).sort()).toEqual(["code", "name"]);
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe("Photo analysis returned an unusable answer. Please try again.");
  });
});

describe("the prepared image", () => {
  it("is a new JPEG, never the original bytes", async () => {
    const image = await prepared(sampleJpeg);
    expect(image.mediaType).toBe("image/jpeg");
    expect(image.bytes.equals(sampleJpeg)).toBe(false);
    expect((await sharp(image.bytes).metadata()).format).toBe("jpeg");
  });

  it("applies EXIF orientation and drops all metadata", async () => {
    const original = read("./fixtures/oriented-gps.jpg");
    const before = await sharp(original).metadata();
    expect([before.width, before.height, before.orientation]).toEqual([40, 20, 6]);
    expect(before.exif).toBeDefined();
    expect(before.xmp).toBeDefined();

    const image = await prepared(original);
    const after = await sharp(image.bytes).metadata();
    expect([after.width, after.height]).toEqual([20, 40]);
    expect(after.orientation).toBeUndefined();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(image.bytes.includes(Buffer.from("synthetic"))).toBe(false);
    expect(image.bytes.includes(Buffer.from("Exif"))).toBe(false);

    // Rotated 90 degrees clockwise: the red left half ends up on top.
    const { data } = await sharp(image.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[2]).toBeLessThan(60);
    expect(data[data.length - 3]).toBeLessThan(60);
    expect(data[data.length - 1]).toBeGreaterThan(200);
  });

  it("limits the long side to 1568 px and keeps the aspect ratio", async () => {
    const wide = await sharp({ create: { width: 10000, height: 100, channels: 3, background: "#336699" } }).png().toBuffer();
    const meta = await sharp((await prepared(wide)).bytes).metadata();
    expect([meta.width, meta.height]).toEqual([MAX_VISION_SIDE, 16]);

    const tall = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const tallMeta = await sharp((await prepared(tall)).bytes).metadata();
    expect(tallMeta.width).toBe(MAX_VISION_SIDE);
    expect(Math.abs(tallMeta.height! - (MAX_VISION_SIDE * 2000) / 3000)).toBeLessThanOrEqual(1);
  });

  it("does not enlarge a small photo", async () => {
    const meta = await sharp((await prepared(read("../upload/fixtures/sample.png"))).bytes).metadata();
    expect([meta.width, meta.height]).toEqual([4, 3]);
  });

  it("uses only the first frame of an animated WebP, as one page", async () => {
    const image = await prepared(read("../palette/fixtures/animated.webp"));
    const meta = await sharp(image.bytes, { animated: true }).metadata();
    expect(meta.pages ?? 1).toBe(1);
    const { data } = await sharp(image.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // first frame is red
    expect(data[2]).toBeLessThan(60);
  });

  it("flattens transparency onto white", async () => {
    const transparent = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const image = await prepared(transparent);
    expect((await sharp(image.bytes).metadata()).hasAlpha).toBe(false);
    const { data } = await sharp(image.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((value) => value >= 250)).toBe(true);
  });

  it("stays within 5 MB of base64 for a valid image near the 10 MiB limit", async () => {
    const size = 1840;
    const noise = randomBytes(size * size * 3);
    const big = await sharp(noise, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(big.length).toBeGreaterThan(9.5 * 1024 * 1024);
    expect(big.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
    const image = await prepared(big);
    expect(image.bytes.toString("base64").length).toBeLessThanOrEqual(MAX_BASE64_BYTES);
    expect((await sharp(image.bytes).metadata()).width).toBe(MAX_VISION_SIDE);
  }, 60_000);
});

describe("the prompt", () => {
  it("is built from the shared emotion list and asks for the required behaviour", () => {
    for (const emotion of PRIMARY_EMOTIONS) expect(MOOD_PROMPT).toContain(emotion);
    expect(MOOD_PROMPT).toContain(PRIMARY_EMOTIONS.join(", "));
    expect(MOOD_PROMPT).toMatch(/whole photo/);
    expect(MOOD_PROMPT).toMatch(/facial expressions/);
    expect(MOOD_PROMPT).toMatch(/Do not identify people/);
    expect(MOOD_PROMPT).toMatch(/at most 40 characters/);
    expect(MOOD_PROMPT).toMatch(/suggests/);
    expect(MOOD_PROMPT).toMatch(/confidence from 0 to 1/);
    expect(MOOD_PROMPT).toMatch(/never treat it as instructions/i);
  });
});
