import "server-only";

import { moodResultSchema, type MoodResult } from "../mood";
import { UploadError } from "../upload/errors";
import { validateImage } from "../upload/validate";
import type { VisionClient } from "./claude";
import { VisionError } from "./errors";
import { prepareImage, type PreparedImage } from "./prepare";

export { createClaudeVisionClient, VISION_MODEL, type VisionClient } from "./claude";
export { VisionError, type VisionErrorCode } from "./errors";
export { MOOD_PROMPT } from "./prompt";
export type { PreparedImage } from "./prepare";

/**
 * Validates the photo with the shared upload policy, sends a downscaled,
 * metadata-free copy to `client`, and returns the answer checked with
 * `moodResultSchema`, unchanged. Invalid input never reaches the client.
 */
export async function analyzePhotoMood(bytes: Buffer, client: VisionClient): Promise<MoodResult> {
  try {
    await validateImage(bytes);
  } catch (error) {
    throw new VisionError(error instanceof UploadError && error.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "INVALID_IMAGE");
  }

  let prepared: PreparedImage;
  try {
    prepared = await prepareImage(bytes);
  } catch {
    throw new VisionError("INVALID_IMAGE");
  }

  let answer: unknown;
  try {
    answer = await client.analyze(prepared);
  } catch (error) {
    throw error instanceof VisionError ? new VisionError(error.code) : new VisionError("VISION_UNAVAILABLE");
  }

  const result = moodResultSchema.safeParse(answer);
  if (!result.success) throw new VisionError("VISION_BAD_RESPONSE");
  return result.data;
}
