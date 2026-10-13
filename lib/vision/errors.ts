import "server-only";

const messages = {
  INVALID_IMAGE: "Choose a valid JPEG, PNG, or WebP image.",
  FILE_TOO_LARGE: "The image must be at most 10 MiB.",
  VISION_NOT_CONFIGURED: "Photo analysis is not set up on this server.",
  VISION_UNAVAILABLE: "Photo analysis is temporarily unavailable. Please try again shortly.",
  VISION_REFUSED: "The photo could not be analyzed.",
  VISION_BAD_RESPONSE: "Photo analysis returned an unusable answer. Please try again.",
} as const;

export type VisionErrorCode = keyof typeof messages;

/**
 * Carries only a stable code and a fixed, user-safe message. It never has a
 * `cause`, and never holds provider text, model output, image data or a key.
 */
export class VisionError extends Error {
  constructor(readonly code: VisionErrorCode) {
    super(messages[code]);
    this.name = "VisionError";
  }
}
