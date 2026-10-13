import "server-only";

import sharp from "sharp";
import { MAX_IMAGE_PIXELS } from "../upload/limits";

/** What a `VisionClient` receives: a newly encoded still image, never the original bytes. */
export interface PreparedImage {
  bytes: Buffer;
  mediaType: "image/jpeg";
}

export const MAX_VISION_SIDE = 1568;
/** Transparent pixels are flattened onto this colour before encoding. */
export const FLATTEN_BACKGROUND = "#ffffff";
/** The API accepts at most 10 MB of base64 per image; stay well under it. */
export const MAX_BASE64_BYTES = 5_000_000;

const QUALITIES = [85, 70, 50, 30];

/**
 * Applies the EXIF orientation, shrinks the first frame to at most 1568 px on
 * the long side (never enlarging), flattens transparency onto white and
 * re-encodes as JPEG. sharp drops all metadata (EXIF, GPS, XMP, IPTC) unless
 * asked to keep it. The input must already have passed `validateImage`.
 */
export async function prepareImage(bytes: Buffer): Promise<PreparedImage> {
  const base = () =>
    sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, page: 0, pages: 1 })
      .autoOrient()
      .resize({ width: MAX_VISION_SIDE, height: MAX_VISION_SIDE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .flatten({ background: FLATTEN_BACKGROUND });

  for (const quality of QUALITIES) {
    const encoded = await base().jpeg({ quality }).toBuffer();
    if (Math.ceil(encoded.length / 3) * 4 <= MAX_BASE64_BYTES) return { bytes: encoded, mediaType: "image/jpeg" };
  }
  throw new Error("The prepared image is too large.");
}
