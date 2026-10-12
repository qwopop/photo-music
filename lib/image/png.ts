import "server-only";

import { crc32 } from "node:zlib";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
const criticalChunks = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
// APNG animation control (acTL), frame control (fcTL) and frame data (fdAT).
const animationChunks = new Set(["acTL", "fcTL", "fdAT"]);

/**
 * How the PNG guard treats APNG animation chunks before the terminal IEND.
 * - `"reject"` (the default and the public upload policy): any animation chunk
 *   makes the whole image invalid, so an APNG never reaches the decoder.
 * - `"default-image"` (internal direct-palette use only): animation chunks are
 *   opaque ancillary data and only the default IDAT image is decoded. Their
 *   frames are neither reconstructed, decoded nor semantically validated.
 */
export type PngAnimationPolicy = "reject" | "default-image";

function invalid(): never {
  // Callers map this fixed internal failure to their safe INVALID_IMAGE error.
  throw new Error("Invalid PNG container.");
}

/** True when the bytes start with the 8-byte PNG signature, whatever their filename or MIME type. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= signature.length && signature.equals(bytes.subarray(0, signature.length));
}

/**
 * libvips can recover complete pixels from a truncated PNG, and ignores APNG
 * animation chunks. Require a complete default-image container: framing,
 * chunk CRCs, chunk order and the terminal IEND. Runs before any decoder is
 * created, in linear time with constant bookkeeping and views into the
 * already size-bounded input. Unless the caller explicitly requests the
 * internal `"default-image"` policy, an animation chunk rejects at once; no
 * declared frame count or frame size is read, so none can drive allocation,
 * loops or decompression.
 */
export function assertCompletePng(bytes: Buffer, animation: PngAnimationPolicy = "reject"): void {
  // Anything other than the exact internal opt-in keeps the safe default.
  const keepDefaultImage = animation === "default-image";
  if (!hasPngSignature(bytes)) invalid();
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
    if (!keepDefaultImage && animationChunks.has(type)) invalid();
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
      // A complete PNG datastream ends here; a decoder ignores a trailing
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
