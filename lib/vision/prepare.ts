import "server-only";

import sharp from "sharp";
import { MAX_IMAGE_PIXELS } from "../upload/limits";
import { VisionError } from "./errors";

export type PreparedMediaType = "image/jpeg" | "image/png" | "image/webp";

/** What a `VisionClient` receives: a newly encoded, metadata-free still image. */
export interface PreparedImage {
  bytes: Buffer;
  mediaType: PreparedMediaType;
}

export const MAX_SIDE_PX = 1568;
/** Transparent areas are flattened onto this colour (white). */
export const FLATTEN_BACKGROUND = "#ffffff";
/** The API allows 5 MB of base64 per image; base64 is 4/3 of the bytes. */
export const MAX_PREPARED_BYTES = Math.floor((5_000_000 * 3) / 4) - 4;
const QUALITIES = [85, 70, 50, 30];

/**
 * Decode the first frame only, apply EXIF orientation, shrink to at most
 * 1568 px on the long side (never enlarging), flatten transparency, and
 * encode as JPEG. sharp drops EXIF, GPS, XMP and IPTC unless asked to keep them.
 */
export async function prepareImage(bytes: Buffer): Promise<PreparedImage> {
  try {
    for (const quality of QUALITIES) {
      const out = await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS })
        .rotate()
        .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
        .flatten({ background: FLATTEN_BACKGROUND })
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= MAX_PREPARED_BYTES) return { bytes: out, mediaType: "image/jpeg" };
    }
  } catch {
    // Decoder errors may describe the data; never expose them.
  }
  throw new VisionError("INVALID_IMAGE");
}
