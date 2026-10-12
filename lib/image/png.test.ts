import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { assertCompletePng, hasPngSignature, type PngAnimationPolicy } from "./png";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const fixture = (name: string) => read(`./fixtures/${name}`);
const png = read("../upload/fixtures/sample.png");
const apng = {
  defaultFrame: fixture("apng-default-frame.apng"),
  separateDefault: read("../palette/fixtures/default-image.apng"),
  missingControls: fixture("apng-missing-controls.apng"),
  corruptLaterFrame: fixture("apng-corrupt-later-frame.apng"),
  overAggregate: fixture("apng-over-aggregate.apng"),
};

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "latin1");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

interface Chunk { type: string; start: number; end: number }

function chunks(bytes: Buffer): Chunk[] {
  const result: Chunk[] = [];
  for (let start = 8; start < bytes.length;) {
    const end = start + bytes.readUInt32BE(start) + 12;
    result.push({ type: bytes.toString("latin1", start + 4, start + 8), start, end });
    start = end;
  }
  return result;
}

/** Insert chunks immediately before the first chunk of the given type. */
function insertBefore(bytes: Buffer, type: string, ...inserted: Buffer[]): Buffer {
  const target = chunks(bytes).find((chunk) => chunk.type === type);
  if (!target) throw new Error(`fixture has no ${type}`);
  return Buffer.concat([bytes.subarray(0, target.start), ...inserted, bytes.subarray(target.start)]);
}

const actl = (frames: number) => {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(frames, 0);
  return pngChunk("acTL", data);
};
const fctl = (sequence: number, side: number) => {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(side, 4);
  data.writeUInt32BE(side, 8);
  return pngChunk("fcTL", data);
};
const fdat = (sequence: number) => {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(sequence, 0);
  return pngChunk("fdAT", data);
};

const accepts = (bytes: Buffer, policy?: PngAnimationPolicy) => expect(() => assertCompletePng(bytes, policy)).not.toThrow();
const rejects = (bytes: Buffer, policy?: PngAnimationPolicy) => expect(() => assertCompletePng(bytes, policy)).toThrow("Invalid PNG container.");

describe("hasPngSignature", () => {
  it("detects the PNG signature from bytes only", () => {
    expect(hasPngSignature(png)).toBe(true);
    expect(hasPngSignature(apng.defaultFrame)).toBe(true);
    expect(hasPngSignature(png.subarray(0, 7))).toBe(false);
    expect(hasPngSignature(read("../upload/fixtures/sample.jpg"))).toBe(false);
    expect(hasPngSignature(Buffer.alloc(0))).toBe(false);
  });
});

describe("assertCompletePng", () => {
  it("accepts complete static PNG datastreams under every policy", () => {
    for (const bytes of [png, read("../palette/fixtures/red-dominant.png"), read("../palette/fixtures/six-colors.png")]) {
      accepts(bytes);
      accepts(bytes, "reject");
      accepts(bytes, "default-image");
    }
  });

  it("accepts ordinary PNG variations: ancillary chunks, split IDAT, indexed PLTE, interlacing and 16-bit samples", async () => {
    const idat = chunks(png).find((chunk) => chunk.type === "IDAT")!;
    const data = png.subarray(idat.start + 8, idat.end - 4);
    const split = Buffer.concat([
      png.subarray(0, idat.start),
      pngChunk("IDAT", data.subarray(0, 5)), pngChunk("IDAT", data.subarray(5)),
      pngChunk("tEXt", Buffer.from("note\0synthetic fixture")),
      png.subarray(idat.end),
    ]);
    accepts(split);
    accepts(await sharp(png).png({ palette: true, colours: 2 }).toBuffer());
    accepts(await sharp(png).png({ progressive: true }).toBuffer());
    accepts(await sharp(png).toColourspace("rgb16").png().toBuffer());
    accepts(await sharp(png).greyscale().ensureAlpha(0.5).png().toBuffer());
  });

  it("keeps the complete-datastream policy: a payload after IEND is not part of the PNG", () => {
    // Bytes after IEND are never decoded, even when they resemble APNG chunks.
    accepts(Buffer.concat([png, Buffer.alloc(1024)]));
    accepts(Buffer.concat([png, actl(2), fctl(0, 1), fdat(1)]));
  });

  it.each(["missing-iend.png", "truncated-iend.png"])("rejects the %s fixture whose IDAT pixels sharp can still recover", async (name) => {
    const bytes = fixture(name);
    await expect(sharp(bytes, { failOn: "warning" }).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    rejects(bytes);
    rejects(bytes, "default-image");
  });

  it.each([1, 2, 4, 8, 11, 12])("rejects a PNG missing its final %i IEND bytes", (removed) => {
    rejects(png.subarray(0, png.length - removed));
    rejects(apng.defaultFrame.subarray(0, apng.defaultFrame.length - removed), "default-image");
  });

  it("rejects corrupt chunk CRCs, including in APNG chunks kept as opaque data", () => {
    for (const [bytes, policy] of [[png, "reject"], [apng.separateDefault, "default-image"]] as const) {
      for (const chunk of chunks(bytes)) {
        const corrupt = Buffer.from(bytes);
        corrupt[chunk.end - 1] ^= 1;
        rejects(corrupt, policy);
      }
    }
  });

  it("rejects out-of-bounds, truncated and malformed chunks", () => {
    const comment = pngChunk("tEXt", Buffer.from("note\0synthetic fixture"));
    const oversized = Buffer.from(comment);
    oversized.writeUInt32BE(0xffffffff, 0);
    rejects(insertBefore(png, "IEND", oversized));
    rejects(insertBefore(png, "IEND", comment.subarray(0, 11)));
    const [header, physical] = chunks(png);
    rejects(Buffer.concat([ // IHDR is not first
      png.subarray(0, 8), png.subarray(physical.start, physical.end), png.subarray(header.start, header.end), png.subarray(physical.end),
    ]));
    rejects(insertBefore(png, "IEND", pngChunk("ab1D", Buffer.alloc(1))));
    rejects(insertBefore(png, "IEND", pngChunk("ABCD", Buffer.alloc(1)))); // unknown critical chunk
    rejects(Buffer.concat([png.subarray(0, -12), pngChunk("IEND", Buffer.from([0]))]));
    rejects(Buffer.from("not a PNG"));
  });

  it("rejects non-consecutive IDAT data", () => {
    const idat = chunks(png).find((chunk) => chunk.type === "IDAT")!;
    const data = png.subarray(idat.start + 8, idat.end - 4);
    rejects(Buffer.concat([
      png.subarray(0, idat.start),
      pngChunk("IDAT", data.subarray(0, 5)), pngChunk("tEXt", Buffer.from("a\0b")), pngChunk("IDAT", data.subarray(5)),
      png.subarray(idat.end),
    ]));
  });

  it.each(Object.entries(apng))("rejects the %s APNG by default and with the explicit reject policy", (_, bytes) => {
    rejects(bytes);
    rejects(bytes, "reject");
  });

  it.each([
    ["acTL", actl(1)],
    ["fcTL", fctl(0, 1)],
    ["fdAT", fdat(1)],
  ])("rejects a lone %s chunk anywhere before IEND by default", (_, chunk) => {
    for (const before of ["pHYs", "IDAT", "IEND"]) {
      const bytes = insertBefore(png, before, chunk);
      rejects(bytes);
      accepts(bytes, "default-image");
    }
  });

  it("treats any policy other than the exact internal default-image request as reject", () => {
    for (const policy of ["Default-Image", "default", "accept", "", undefined]) {
      rejects(apng.defaultFrame, policy as PngAnimationPolicy);
    }
  });

  it.each(Object.entries(apng))("keeps the %s APNG's well-framed default image under the internal default-image policy", (_, bytes) => {
    accepts(bytes, "default-image");
  });

  it("never uses untrusted frame counts or sizes for allocation or loops", () => {
    // 4,294,967,295 declared frames of 4,294,967,295² pixels: only the bytes present are scanned.
    const declared = insertBefore(png, "IDAT", actl(0xffffffff), fctl(0, 0xffffffff));
    rejects(declared);
    accepts(declared, "default-image");
  });
});
