import "server-only";

import sharp from "sharp";
import { UploadError } from "./errors";
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS } from "./limits";

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ValidatedImage {
  bytes: Buffer;
  mimeType: ImageMimeType;
}

const mimeTypes = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

/** Decode all pixels, with a finite allocation limit and strict corrupt-data handling. */
export async function validateImage(bytes: Buffer): Promise<ValidatedImage> {
  if (bytes.length > MAX_FILE_BYTES) throw new UploadError("FILE_TOO_LARGE");
  if (bytes.length === 0) throw new UploadError("INVALID_IMAGE");

  try {
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
      // Decode every frame as well: animated PNG/WebP cannot hide a corrupt later frame.
      animated: true,
    });
    const metadata = await decoder.metadata();
    const format = metadata.format;
    if (format !== "jpeg" && format !== "png" && format !== "webp") {
      throw new UploadError("INVALID_IMAGE");
    }
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixels === 0 || pixels > MAX_IMAGE_PIXELS) throw new UploadError("INVALID_IMAGE");

    // metadata() only parses headers. raw().toBuffer() forces complete pixel decoding.
    await decoder.raw().toBuffer();
    return { bytes, mimeType: mimeTypes[format] };
  } catch {
    // libvips errors may contain details about the submitted data. Never expose/log them.
    throw new UploadError("INVALID_IMAGE");
  }
}
