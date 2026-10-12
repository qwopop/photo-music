import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS } from "../upload/limits";
import { extractPalette, MAX_PALETTE_SIDE, PaletteError } from "./index";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const png = fixture("red-dominant.png");
const jpeg = fixture("solid.jpg");
const webp = fixture("solid.webp");

afterEach(() => vi.restoreAllMocks());

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

describe("extractPalette", () => {
  it.each([
    ["JPEG", jpeg], ["PNG", png], ["WebP", webp],
  ])("returns the shared six-color normalized result for %s without mutating bytes", async (_, bytes) => {
    const input = bytes as Buffer;
    const original = Buffer.from(input);
    const result = await extractPalette(input);
    expect(Object.keys(result).sort()).toEqual(["brightness", "colors"]);
    expect(result.colors).toHaveLength(6);
    for (const color of result.colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(Number.isFinite(result.brightness)).toBe(true);
    expect(result.brightness).toBeGreaterThanOrEqual(0);
    expect(result.brightness).toBeLessThanOrEqual(1);
    expect(input.equals(original)).toBe(true);
  });

  it("orders the actual dominant lossless color before a minority color and repeats only a detected color", async () => {
    const result = await extractPalette(png);
    expect(result.colors).toEqual(["#ff0000", "#0000ff", "#0000ff", "#0000ff", "#0000ff", "#0000ff"]);
    expect(result.brightness).toBeCloseTo((3 * 0.2126 + 0.0722) / 4, 12);
  });

  it("includes all six equally prevalent separated colors with ascending-hex tie ordering", async () => {
    const result = await extractPalette(fixture("six-colors.png"));
    expect(result.colors).toEqual(["#0000ff", "#00ff00", "#00ffff", "#ff0000", "#ff00ff", "#ffff00"]);
    expect(result.brightness).toBeCloseTo(0.5, 12);
  });

  it.each([
    ["black", "#000000", 0], ["white", "#ffffff", 1],
  ])("repeats only solid %s, with meaningful exact brightness", async (name, color, brightness) => {
    const result = await extractPalette(fixture(`${name}.png`));
    expect(result).toEqual({ colors: Array(6).fill(color), brightness });
  });

  it("measures mean brightness across all colors rather than just the dominant entry", async () => {
    const black = await extractPalette(fixture("black.png"));
    const white = await extractPalette(fixture("white.png"));
    const mixed = await extractPalette(fixture("black-white.png"));
    expect(mixed.colors).toEqual(["#000000", "#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff"]);
    expect(mixed.brightness).toBeCloseTo(0.5, 12);
    expect(mixed.brightness).toBeGreaterThan(black.brightness);
    expect(mixed.brightness).toBeLessThan(white.brightness);
  });

  it("ignores hidden RGB from fully transparent pixels", async () => {
    expect(await extractPalette(fixture("hidden-transparent.png"))).toEqual({
      colors: Array(6).fill("#00ff00"), brightness: 0.7152,
    });
  });

  it("weights partially transparent prevalence and brightness by alpha", async () => {
    const result = await extractPalette(fixture("partial-alpha.png"));
    expect(result.colors[0]).toBe("#ff0000");
    expect(result.colors[1]).toBe("#0000ff");
    expect(new Set(result.colors)).toEqual(new Set(["#ff0000", "#0000ff"]));
    expect(result.brightness).toBeCloseTo((0.2126 * 255 + 0.0722 * 128) / (255 + 128), 12);
  });

  it("uses alpha weight rather than raw pixel counts to choose the dominant color", async () => {
    const bytes = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 64, 0, 0, 255, 64]), {
      raw: { width: 3, height: 1, channels: 4 },
    }).png().toBuffer();
    const result = await extractPalette(bytes);
    expect(result.colors[0]).toBe("#ff0000");
    expect(result.brightness).toBeCloseTo((0.2126 * 255 + 0.0722 * 128) / 383, 12);
  });

  it("uses the weighted mean of nearby shades in a five-bit representative bucket", async () => {
    const result = await extractPalette(fixture("near-shades.png"));
    expect(result.colors).toEqual(["#f10101", "#0000ff", "#0000ff", "#0000ff", "#0000ff", "#0000ff"]);
    const expected = (0.2126 * (240 + 241) + 0.7152 + 0.0722 * (1 + 255)) / (255 * 3);
    expect(result.brightness).toBeCloseTo(expected, 12);
  });

  it.each(["solid.jpg", "solid.webp"])("represents the genuine lossy %s color within documented tolerance", async (name) => {
    const result = await extractPalette(fixture(name));
    const expected = [204, 102, 34];
    for (const [index, channel] of rgb(result.colors[0]).entries()) {
      expect(Math.abs(channel - expected[index])).toBeLessThanOrEqual(3);
    }
    expect(result.colors.every((color) => color === result.colors[0])).toBe(true);
    expect(result.brightness).toBeCloseTo((0.2126 * 204 + 0.7152 * 102 + 0.0722 * 34) / 255, 2);
  });

  it("is deterministic across repeated and concurrent extraction", async () => {
    const input = fixture("six-colors.png");
    const first = await extractPalette(input);
    const results = await Promise.all([extractPalette(input), extractPalette(input), extractPalette(input)]);
    for (const result of results) expect(result).toEqual(first);
  });

  it("bounds palette sampling while retaining exact solid-color values in a larger image", async () => {
    expect(MAX_PALETTE_SIDE).toBe(256);
    const bytes = await sharp({ create: { width: 1024, height: 512, channels: 3, background: "white" } }).png().toBuffer();
    expect(await extractPalette(bytes)).toEqual({ colors: Array(6).fill("#ffffff"), brightness: 1 });
  });

  it("extracts the first visual WebP frame rather than later frames", async () => {
    const bytes = fixture("animated.webp");
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    expect(await extractPalette(bytes)).toEqual({ colors: Array(6).fill("#ff0000"), brightness: 0.2126 });
  });

  it("uses the documented default PNG image for APNG, which can differ from its animation", async () => {
    const bytes = fixture("default-image.apng");
    // This valid APNG has a separate red default IDAT image and blue animation
    // frame. libvips exposes the red default only; full APNG handling is #37.
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.pages).toBeUndefined();
    expect(await extractPalette(bytes)).toEqual({ colors: Array(6).fill("#ff0000"), brightness: 0.2126 });
  });

  it("rejects fully transparent content with the fixed NO_VISIBLE_PIXELS error", async () => {
    await expect(extractPalette(fixture("transparent.png"))).rejects.toMatchObject({
      name: "PaletteError", code: "NO_VISIBLE_PIXELS", message: "The image has no visible pixels.",
    });
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("synthetic private text")],
    ["unsupported GIF", readFileSync(new URL("../upload/fixtures/unsupported.gif", import.meta.url))],
    ["JPEG signature", Buffer.from([0xff, 0xd8, 0xff])],
    ["PNG signature", png.subarray(0, 8)],
    ["WebP signature", webp.subarray(0, 12)],
    ["truncated JPEG", jpeg.subarray(0, jpeg.length - 25)],
    ["truncated PNG", png.subarray(0, Math.floor(png.length / 2))],
    ["truncated WebP", webp.subarray(0, webp.length - 10)],
    ["truncated WebP animation", fixture("animated.webp").subarray(0, fixture("animated.webp").length - 10)],
  ])("rejects %s with safe image errors", async (_, bytes) => {
    await expect(extractPalette(bytes as Buffer)).rejects.toMatchObject({
      name: "PaletteError", code: "INVALID_IMAGE", message: "Choose a valid JPEG, PNG, or WebP image.",
    });
  });

  it("validates later WebP frames even though only the first frame is sampled", async () => {
    const bytes = Buffer.from(fixture("animated.webp"));
    const secondFrame = bytes.lastIndexOf(Buffer.from("VP8L"));
    expect(secondFrame).toBeGreaterThan(0);
    bytes.fill(0xff, secondFrame + 8, bytes.length);
    await expect(extractPalette(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it.each([1, 2, 4, 8, 11, 12])("rejects PNG missing %i terminal IEND bytes despite decodable IDAT pixels", async (removed) => {
    await expect(extractPalette(png.subarray(0, png.length - removed))).rejects.toMatchObject({
      name: "PaletteError", code: "INVALID_IMAGE", message: "Choose a valid JPEG, PNG, or WebP image.",
    });
  });

  it("rejects a damaged IEND checksum without exposing chunk/decoder details", async () => {
    const bytes = Buffer.from(png);
    bytes[bytes.length - 1] ^= 1;
    await expect(extractPalette(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("rejects a malformed nonempty terminal IEND chunk", async () => {
    const bytes = Buffer.concat([png.subarray(0, -12), pngChunk("IEND", Buffer.from([0]))]);
    await expect(extractPalette(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("rejects an incomplete or checksum-corrupt ancillary chunk before a complete IEND", async () => {
    const comment = pngChunk("tEXt", Buffer.from("note\0synthetic fixture"));
    const corrupt = Buffer.from(comment);
    corrupt[corrupt.length - 1] ^= 1;
    const malformed = Buffer.from(comment);
    malformed.writeUInt32BE(0xffffffff, 0);
    for (const badChunk of [corrupt, malformed]) {
      await expect(extractPalette(Buffer.concat([png.subarray(0, -12), badChunk, png.subarray(-12)])))
        .rejects.toMatchObject({ code: "INVALID_IMAGE" });
    }
  });

  it("accepts a complete valid PNG with ancillary data and split consecutive IDAT chunks", async () => {
    const chunks: Buffer[] = [png.subarray(0, 8)];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const end = offset + length + 12;
      const type = png.toString("ascii", offset + 4, offset + 8);
      if (type === "IDAT") {
        const data = png.subarray(offset + 8, end - 4);
        const midpoint = Math.floor(data.length / 2);
        chunks.push(pngChunk("IDAT", data.subarray(0, midpoint)), pngChunk("IDAT", data.subarray(midpoint)));
      } else {
        if (type === "IEND") chunks.push(pngChunk("tEXt", Buffer.from("note\0synthetic fixture")));
        chunks.push(png.subarray(offset, end));
      }
      offset = end;
    }
    expect(await extractPalette(Buffer.concat(chunks))).toEqual(await extractPalette(png));
  });

  it("accepts the inclusive file-size boundary for a complete PNG datastream", async () => {
    const bytes = Buffer.alloc(MAX_FILE_BYTES);
    png.copy(bytes);
    expect(await extractPalette(bytes)).toEqual(await extractPalette(png));
  });

  it("preserves valid indexed-color PNG palette data", async () => {
    const bytes = await sharp(png).png({ palette: true, colours: 2 }).toBuffer();
    expect(await extractPalette(bytes)).toEqual(await extractPalette(png));
  });

  it("rejects non-consecutive IDAT data even when a complete IEND is present", async () => {
    const chunks: Buffer[] = [png.subarray(0, 8)];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const end = offset + length + 12;
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
        const data = png.subarray(offset + 8, end - 4);
        const midpoint = Math.floor(data.length / 2);
        chunks.push(
          pngChunk("IDAT", data.subarray(0, midpoint)),
          pngChunk("tEXt", Buffer.from("note\0synthetic fixture")),
          pngChunk("IDAT", data.subarray(midpoint)),
        );
      } else chunks.push(png.subarray(offset, end));
      offset = end;
    }
    await expect(extractPalette(Buffer.concat(chunks))).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("honors the shared 10 MiB direct-input limit before decoding", async () => {
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    jpeg.copy(bytes);
    await expect(extractPalette(bytes)).rejects.toMatchObject({ code: "FILE_TOO_LARGE", message: "The image must be at most 10 MiB." });
  });

  it("honors the shared inclusive 10 MiB limit for a valid JPEG", async () => {
    const bytes = Buffer.alloc(MAX_FILE_BYTES);
    jpeg.copy(bytes);
    const result = await extractPalette(bytes);
    expect(result.colors).toHaveLength(6);
    expect(result.colors.every((color) => color === result.colors[0])).toBe(true);
  });

  it("honors the shared decoded-pixel limit independently of compressed file size", async () => {
    const width = 5001;
    const height = 5000;
    expect(width * height).toBeGreaterThan(MAX_IMAGE_PIXELS);
    const bytes = await sharp({ create: { width, height, channels: 3, background: "black" } }).png().toBuffer();
    expect(bytes.length).toBeLessThan(MAX_FILE_BYTES);
    await expect(extractPalette(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("bounds aggregate WebP animation pixels even when each individual frame fits", async () => {
    const bytes = fixture("over-pixel-animation.webp");
    // Two 4000×4000 lossless frames: each is under 25M, their aggregate is 32M.
    expect(bytes.length).toBeLessThan(MAX_FILE_BYTES);
    await expect(extractPalette(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("uses only fixed safe error text and never logs rejected bytes or decoder details", async () => {
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    await expect(extractPalette(Buffer.from("secret-like synthetic input"))).rejects.toBeInstanceOf(PaletteError);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
