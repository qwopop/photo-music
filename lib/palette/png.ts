import "server-only";

import { crc32 } from "node:zlib";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
const criticalChunks = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

function invalid(): never {
  // The public extractor maps this fixed internal failure to INVALID_IMAGE.
  throw new Error("Invalid PNG container.");
}

/**
 * libvips can recover complete pixels from a truncated PNG. Require a complete
 * default-image container too. Runs after the shared size/decoder checks, in
 * linear time with constant bookkeeping and views into the bounded input.
 * APNG animation/control chunks are opaque: no frame reconstruction/decoding.
 */
export function assertCompletePng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(signature)) invalid();
  let hasHeader = false;
  let hasPalette = false;
  let hasImageData = false;
  let imageDataEnded = false;
  let compressedBytes = 0;
  let colorType = -1;

  for (let offset = 8; offset < bytes.length;) {
    if (bytes.length - offset < 12) invalid();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid();
    const end = offset + length + 12;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (!hasHeader && type !== "IHDR") invalid();

    if (type === "IHDR") {
      if (hasHeader || offset !== 8 || length !== 13) invalid();
      hasHeader = true;
      colorType = bytes[offset + 17];
    } else if (type === "PLTE") {
      if (hasPalette || hasImageData || length === 0 || length > 768 || length % 3 !== 0) invalid();
      if (colorType === 0 || colorType === 4) invalid();
      hasPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || (colorType === 3 && !hasPalette)) invalid();
      hasImageData = true;
      compressedBytes += length;
    } else if (type === "IEND") {
      if (length !== 0 || !hasImageData || compressedBytes === 0) invalid();
      // A complete PNG datastream ends here; a decoder may ignore a trailing
      // payload, just as with the supported inclusive-size JPEG fixtures.
      return;
    } else {
      if (type[0] === type[0].toUpperCase() && !criticalChunks.has(type)) invalid();
    }
    if (hasImageData && type !== "IDAT") imageDataEnded = true;
    offset = end;
  }
  // Includes a complete IDAT followed by missing or partially written IEND.
  invalid();
}
