import "server-only";

import sharp from "sharp";
import { assertCompletePng, hasPngSignature, type PngAnimationPolicy } from "../image/png";
import { UploadError } from "./errors";
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS } from "./limits";

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ValidatedImage {
  bytes: Buffer;
  mimeType: ImageMimeType;
}

/**
 * Internal server-side options. `POST /api/upload` never passes any, so public
 * uploads always use the safe defaults; nothing a client sends can select them.
 */
export interface ImageValidationOptions {
  /** Defaults to `"reject"`. Only the direct palette utility requests `"default-image"`. */
  pngAnimation?: PngAnimationPolicy;
}

const mimeTypes = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

/**
 * Check PNG framing first, then decode all pixels, with a finite allocation
 * limit and strict corrupt-data handling. By default an APNG rejects before
 * any decoder is created.
 */
export async function validateImage(bytes: Buffer, options?: ImageValidationOptions): Promise<ValidatedImage> {
  if (bytes.length > MAX_FILE_BYTES) throw new UploadError("FILE_TOO_LARGE");
  if (bytes.length === 0) throw new UploadError("INVALID_IMAGE");
  const pngAnimation: PngAnimationPolicy = options?.pngAnimation === "default-image" ? "default-image" : "reject";

  try {
    // The bytes decide the format, never a filename or client MIME type. sharp
    // can recover pixels from an incomplete PNG and silently ignores APNG
    // animation chunks, so the bounded container guard runs before decoding.
    const png = hasPngSignature(bytes);
    if (png) assertCompletePng(bytes, pngAnimation);

    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
      // Decode every WebP frame as well, so an animation cannot hide a corrupt
      // later frame. libvips decodes only a PNG's default image; APNG frames
      // were rejected above (or are opaque under the internal palette policy).
      animated: true,
    });
    const metadata = await decoder.metadata();
    const format = metadata.format;
    if (format !== "jpeg" && format !== "png" && format !== "webp") {
      throw new UploadError("INVALID_IMAGE");
    }
    // Never accept a PNG that skipped the container guard.
    if ((format === "png") !== png) throw new UploadError("INVALID_IMAGE");
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixels === 0 || pixels > MAX_IMAGE_PIXELS) throw new UploadError("INVALID_IMAGE");

    // metadata() only parses headers. raw().toBuffer() forces complete pixel decoding.
    await decoder.raw().toBuffer();
    return { bytes, mimeType: mimeTypes[format] };
  } catch {
    // Guard and libvips errors may describe the submitted data. Never expose/log them.
    throw new UploadError("INVALID_IMAGE");
  }
}
