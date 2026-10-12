import "server-only";

import sharp from "sharp";
import { UploadError } from "../upload/errors";
import { MAX_IMAGE_PIXELS } from "../upload/limits";
import { validateImage } from "../upload/validate";

/** Shared server-side contract for later photo analysis and result-page theming. */
export interface PaletteResult {
  colors: string[];
  brightness: number;
}

const messages = {
  INVALID_IMAGE: "Choose a valid JPEG, PNG, or WebP image.",
  FILE_TOO_LARGE: "The image must be at most 10 MiB.",
  NO_VISIBLE_PIXELS: "The image has no visible pixels.",
} as const;

export class PaletteError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "PaletteError";
  }
}

export const MAX_PALETTE_SIDE = 256;
const COLOR_COUNT = 6;

interface Bucket {
  weight: number;
  red: number;
  green: number;
  blue: number;
}

/**
 * Validate the entire input first, then sample at most 256×256 first-frame
 * pixels. Five-bit RGB buckets group nearby shades; their alpha-weighted means
 * are representatives. Equal weights sort by ascending hex value.
 *
 * Unlike public upload, this direct utility explicitly asks the shared
 * validator for an APNG's default IDAT image. The complete-container/CRC guard
 * and the file and default-image pixel limits still apply; additional APNG
 * frames stay opaque and are neither validated nor selected.
 */
export async function extractPalette(bytes: Buffer): Promise<PaletteResult> {
  try {
    await validateImage(bytes, { pngAnimation: "default-image" });
    const { data } = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
      page: 0,
      pages: 1,
    })
      .toColourspace("srgb")
      .ensureAlpha()
      .resize({ width: MAX_PALETTE_SIDE, height: MAX_PALETTE_SIDE, fit: "inside", withoutEnlargement: true, kernel: "nearest" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map<number, Bucket>();
    let totalWeight = 0;
    let totalRed = 0;
    let totalGreen = 0;
    let totalBlue = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3];
      if (alpha === 0) continue;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { weight: 0, red: 0, green: 0, blue: 0 };
        buckets.set(key, bucket);
      }
      bucket.weight += alpha;
      bucket.red += red * alpha;
      bucket.green += green * alpha;
      bucket.blue += blue * alpha;
      totalWeight += alpha;
      totalRed += red * alpha;
      totalGreen += green * alpha;
      totalBlue += blue * alpha;
    }
    if (totalWeight === 0) throw new PaletteError("NO_VISIBLE_PIXELS");

    const representatives = [...buckets.values()].map(({ weight, red, green, blue }) => {
      const rgb = (Math.round(red / weight) << 16) | (Math.round(green / weight) << 8) | Math.round(blue / weight);
      return { weight, hex: `#${rgb.toString(16).padStart(6, "0")}` };
    });
    representatives.sort((a, b) => b.weight - a.weight || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
    const colors = representatives.slice(0, COLOR_COUNT).map(({ hex }) => hex);
    // Repeat the least-prevalent detected representative to preserve ordering;
    // never invent filler colors for solid or low-color images.
    while (colors.length < COLOR_COUNT) colors.push(colors[colors.length - 1]);
    const brightness = (0.2126 * totalRed + 0.7152 * totalGreen + 0.0722 * totalBlue) / (255 * totalWeight);
    return { colors, brightness: Math.max(0, Math.min(1, brightness)) };
  } catch (error) {
    if (error instanceof PaletteError) throw error;
    if (error instanceof UploadError && error.code === "FILE_TOO_LARGE") throw new PaletteError("FILE_TOO_LARGE");
    throw new PaletteError("INVALID_IMAGE");
  }
}
