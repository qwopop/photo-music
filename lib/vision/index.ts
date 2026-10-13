import "server-only";

import { moodResultSchema, type MoodResult } from "../mood";
import { UploadError } from "../upload/errors";
import { validateImage } from "../upload/validate";
import { VisionError } from "./errors";
import { prepareImage, type PreparedImage } from "./prepare";

export { createClaudeVisionClient } from "./claude";
export { VisionError } from "./errors";
export type { VisionErrorCode } from "./errors";
export { MOOD_PROMPT } from "./prompt";
export type { PreparedImage } from "./prepare";

/** Sends one prepared image to a vision model and returns its parsed, unchecked answer. */
export interface VisionClient {
  analyze(image: PreparedImage): Promise<unknown>;
}

/**
 * Validate the photo, send a downscaled metadata-free copy to the client, and
 * return the checked `MoodResult`. Throws only `VisionError`.
 */
export async function analyzePhotoMood(bytes: Buffer, client: VisionClient): Promise<MoodResult> {
  try {
    await validateImage(bytes);
  } catch (error) {
    throw new VisionError(error instanceof UploadError && error.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "INVALID_IMAGE");
  }
  const prepared = await prepareImage(bytes);

  let answer: unknown;
  try {
    answer = await client.analyze(prepared);
  } catch (error) {
    throw error instanceof VisionError ? error : new VisionError("VISION_UNAVAILABLE");
  }
  const result = moodResultSchema.safeParse(answer);
  if (!result.success) throw new VisionError("VISION_BAD_RESPONSE");
  return result.data;
}
