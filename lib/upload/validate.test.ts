import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS } from "./limits";
import { validateImage, type ImageValidationOptions } from "./validate";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const samples = {
  jpeg: read("./fixtures/sample.jpg"),
  png: read("./fixtures/sample.png"),
  webp: read("./fixtures/sample.webp"),
};
const animatedWebp = read("../palette/fixtures/animated.webp");
const apng = {
  "animated default image": read("../image/fixtures/apng-default-frame.apng"),
  "separate fallback default image": read("../palette/fixtures/default-image.apng"),
  "missing animation controls": read("../image/fixtures/apng-missing-controls.apng"),
  "corrupt later frame data": read("../image/fixtures/apng-corrupt-later-frame.apng"),
  "over-aggregate animation": read("../image/fixtures/apng-over-aggregate.apng"),
};
const incompletePng = {
  "missing IEND": read("../image/fixtures/missing-iend.png"),
  "truncated IEND": read("../image/fixtures/truncated-iend.png"),
};
const INTERNAL: ImageValidationOptions = { pngAnimation: "default-image" };

afterEach(() => vi.restoreAllMocks());

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "latin1");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

/** Spies on sharp's real constructor input handling and decoding methods without changing them. */
function spyOnDecoder() {
  const prototype = sharp.prototype as unknown as Record<"_createInputDescriptor" | "metadata" | "raw" | "toBuffer", () => unknown>;
  return [
    vi.spyOn(prototype, "_createInputDescriptor"),
    vi.spyOn(prototype, "metadata"),
    vi.spyOn(prototype, "raw"),
    vi.spyOn(prototype, "toBuffer"),
  ];
}

async function expectInvalid(bytes: Buffer, options?: ImageValidationOptions) {
  await expect(validateImage(bytes, options)).rejects.toMatchObject({
    name: "UploadError", code: "INVALID_IMAGE", status: 415, message: "Choose a valid JPEG, PNG, or WebP image.",
  });
}

describe("validateImage default (public upload) policy", () => {
  it.each(Object.entries(samples))("accepts a genuine %s and returns the original buffer", async (format, bytes) => {
    const decoder = spyOnDecoder();
    const result = await validateImage(bytes);
    expect(result).toEqual({ bytes, mimeType: `image/${format}` });
    expect(result.bytes).toBe(bytes);
    for (const spy of decoder) expect(spy).toHaveBeenCalled();
  });

  it("accepts ordinary PNG variations after both the container guard and genuine decoding", async () => {
    const idatStart = 33 + 21; // after the sample's IHDR and pHYs chunks
    const idatEnd = idatStart + samples.png.readUInt32BE(idatStart) + 12;
    const data = samples.png.subarray(idatStart + 8, idatEnd - 4);
    const variations = [
      Buffer.concat([
        samples.png.subarray(0, idatStart),
        pngChunk("IDAT", data.subarray(0, 5)), pngChunk("IDAT", data.subarray(5)),
        pngChunk("tEXt", Buffer.from("note\0synthetic fixture")),
        samples.png.subarray(idatEnd),
      ]),
      await sharp(samples.png).png({ palette: true, colours: 2 }).toBuffer(),
      await sharp(samples.png).png({ progressive: true }).toBuffer(),
      await sharp(samples.png).toColourspace("rgb16").png().toBuffer(),
      await sharp(samples.png).greyscale().ensureAlpha(0.5).png().toBuffer(),
      Buffer.concat([samples.png, Buffer.alloc(64)]), // payload after the complete datastream
    ];
    expect(samples.png.toString("latin1", idatStart + 4, idatStart + 8)).toBe("IDAT");
    for (const bytes of variations) {
      expect(await validateImage(bytes)).toEqual({ bytes, mimeType: "image/png" });
    }
  });

  it.each(Object.entries(incompletePng))("rejects a PNG with %s before decoding, although sharp alone recovers its pixels", async (_, bytes) => {
    const { data, info } = await sharp(bytes, { failOn: "warning" }).raw().toBuffer({ resolveWithObject: true });
    expect(info.width * info.height).toBe(12);
    expect(data.length).toBeGreaterThan(0);
    const decoder = spyOnDecoder();
    await expectInvalid(bytes);
    for (const spy of decoder) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a PNG with a corrupt chunk CRC before decoding", async () => {
    for (let offset = 8; offset < samples.png.length;) {
      const end = offset + samples.png.readUInt32BE(offset) + 12;
      const bytes = Buffer.from(samples.png);
      bytes[end - 2] ^= 0x10;
      const decoder = spyOnDecoder();
      await expectInvalid(bytes);
      for (const spy of decoder) expect(spy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      offset = end;
    }
  });

  it("rejects an out-of-bounds chunk length", async () => {
    const bytes = Buffer.from(samples.png);
    bytes.writeUInt32BE(samples.png.length, 33); // the pHYs chunk claims more bytes than exist
    await expectInvalid(bytes);
  });

  it.each(Object.entries(apng))("rejects an APNG with %s before any decoder exists", async (_, bytes) => {
    // sharp alone decodes only the default image, so it would accept every one of these.
    const strict = { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, animated: true } as const;
    await expect(sharp(bytes, strict).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    const decoder = spyOnDecoder();
    await expectInvalid(bytes);
    await expectInvalid(bytes, { pngAnimation: "reject" });
    for (const spy of decoder) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an APNG regardless of an unknown or misspelled policy value", async () => {
    for (const pngAnimation of ["Default-Image", "default", "allow", ""]) {
      await expectInvalid(apng["animated default image"], { pngAnimation } as unknown as ImageValidationOptions);
    }
  });

  it("rejects each lone APNG animation/control chunk inserted into an otherwise valid PNG", async () => {
    const iend = samples.png.subarray(-12);
    for (const type of ["acTL", "fcTL", "fdAT"]) {
      const bytes = Buffer.concat([samples.png.subarray(0, -12), pngChunk(type, Buffer.alloc(type === "fcTL" ? 26 : 8)), iend]);
      await expectInvalid(bytes);
    }
  });

  it("keeps JPEG, WebP and all-frame animated WebP validation", async () => {
    expect(await validateImage(animatedWebp)).toEqual({ bytes: animatedWebp, mimeType: "image/webp" });
    const corruptLater = Buffer.from(animatedWebp);
    corruptLater.fill(0xff, corruptLater.lastIndexOf(Buffer.from("VP8L")) + 8);
    await expectInvalid(corruptLater);
    await expectInvalid(read("../palette/fixtures/over-pixel-animation.webp"));
    await expectInvalid(samples.jpeg.subarray(0, samples.jpeg.length - 25));
    await expectInvalid(read("./fixtures/unsupported.gif"));
  });

  it("keeps the inclusive file limit ahead of all parsing", async () => {
    const decoder = spyOnDecoder();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    apng["animated default image"].copy(bytes);
    await expect(validateImage(bytes)).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    await expect(validateImage(bytes, INTERNAL)).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    for (const spy of decoder) expect(spy).not.toHaveBeenCalled();
  });

  it("never logs rejected bytes or guard/decoder details", async () => {
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    for (const bytes of [...Object.values(apng), ...Object.values(incompletePng)]) {
      const error = await validateImage(bytes).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "INVALID_IMAGE" });
      expect(String((error as Error).stack)).not.toContain("PNG container");
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("validateImage internal default-image policy", () => {
  it.each(Object.entries(apng))("keeps the well-framed default image of an APNG with %s; its frames stay opaque", async (_, bytes) => {
    // Only the default image is decoded and pixel-bounded (4000×4000 for the
    // over-aggregate fixture). Animation frames are neither decoded nor validated.
    expect(await validateImage(bytes, INTERNAL)).toEqual({ bytes, mimeType: "image/png" });
  });

  it("still requires complete framing, CRCs and IEND", async () => {
    const bytes = apng["animated default image"];
    await expectInvalid(bytes.subarray(0, -12), INTERNAL);
    await expectInvalid(bytes.subarray(0, -1), INTERNAL);
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.indexOf("fdAT", 0, "latin1") + 6] ^= 1; // opaque fdAT data no longer matches its CRC
    await expectInvalid(corrupt, INTERNAL);
    for (const missing of Object.values(incompletePng)) await expectInvalid(missing, INTERNAL);
  });

  it("still bounds the default image's decoded pixels", async () => {
    const width = 5001;
    const height = 5000;
    expect(width * height).toBeGreaterThan(MAX_IMAGE_PIXELS);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 1; // 1-bit grayscale keeps the synthetic data small
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(1, 0);
    const rows = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
    const bytes = Buffer.concat([
      samples.png.subarray(0, 8), pngChunk("IHDR", header), pngChunk("acTL", animation),
      pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND"),
    ]);
    expect(bytes.length).toBeLessThan(MAX_FILE_BYTES);
    await expectInvalid(bytes, INTERNAL);
  });

  it("keeps all other formats identical to the default policy", async () => {
    for (const [format, bytes] of Object.entries(samples)) {
      expect(await validateImage(bytes, INTERNAL)).toEqual({ bytes, mimeType: `image/${format}` });
    }
    await expectInvalid(read("../palette/fixtures/over-pixel-animation.webp"), INTERNAL);
  });
});
