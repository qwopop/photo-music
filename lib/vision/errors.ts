import "server-only";

const messages = {
  INVALID_IMAGE: "The image could not be read. Choose a valid JPEG, PNG, or WebP image.",
  FILE_TOO_LARGE: "The image must be at most 10 MiB.",
  VISION_NOT_CONFIGURED: "Photo analysis is not set up on this server.",
  VISION_UNAVAILABLE: "Photo analysis is temporarily unavailable. Please try again shortly.",
  VISION_REFUSED: "The photo could not be analyzed.",
  VISION_BAD_RESPONSE: "Photo analysis returned an unusable answer. Please try again.",
} as const;

export type VisionErrorCode = keyof typeof messages;

/**
 * The only error `analyzePhotoMood` throws. It carries a stable code and fixed
 * text, never a cause, provider message, HTTP body, model output, image data or key.
 */
export class VisionError extends Error {
  constructor(readonly code: VisionErrorCode) {
    super(messages[code]);
    this.name = "VisionError";
  }
}
