import "server-only";

import { z } from "zod";
import { getCurrentUser } from "../auth";
import { moodResultSchema } from "../mood";
import { playlistSchema } from "../playlist";
import { preferencesSchema } from "../preferences";
import { extractPalette, PaletteError } from "../palette";
import { deletePhoto, StorageError, uploadPhoto } from "../storage";
import { consumeUpload, releaseUpload } from "../upload/store";
import { PhotoResultError, getPhotoResultBySaveId, savePhotoResult } from "../db/photo-results";

const inputSchema = z.strictObject({
  uploadHandle: z.string().min(1).max(128),
  saveId: z.string().uuid(),
  mood: moodResultSchema,
  moodCorrected: z.boolean(),
  preferences: preferencesSchema,
  playlist: playlistSchema,
});

export type SaveResultState =
  | { ok: true; id: string; created: boolean }
  | { ok: false; code: "unauthorized" | "invalid-input" | "upload-expired" | "unavailable"; message: string };

export interface SaveResultDependencies {
  getCurrentUser: typeof getCurrentUser;
  consumeUpload: typeof consumeUpload;
  releaseUpload: typeof releaseUpload;
  extractPalette: typeof extractPalette;
  uploadPhoto: typeof uploadPhoto;
  deletePhoto: typeof deletePhoto;
  getPhotoResultBySaveId: typeof getPhotoResultBySaveId;
  savePhotoResult: typeof savePhotoResult;
}

const defaultDependencies: SaveResultDependencies = {
  getCurrentUser,
  consumeUpload,
  releaseUpload,
  extractPalette,
  uploadPhoto,
  deletePhoto,
  getPhotoResultBySaveId,
  savePhotoResult,
};

function failure(code: Extract<SaveResultState, { ok: false }>["code"]): SaveResultState {
  const messages = {
    unauthorized: "Sign in to save this result.",
    "invalid-input": "This result could not be saved.",
    "upload-expired": "This photo is no longer available, please upload it again.",
    unavailable: "Saving failed. Please try again.",
  } as const;
  return { ok: false, code, message: messages[code] };
}

export async function saveResult(input: unknown, deps: SaveResultDependencies = defaultDependencies): Promise<SaveResultState> {
  let user;
  try {
    user = await deps.getCurrentUser();
  } catch {
    console.error("Could not identify the current user for saving.");
    return failure("unavailable");
  }
  if (!user) return failure("unauthorized");

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid-input");
  const value = parsed.data;
  if (
    JSON.stringify(value.mood) !== JSON.stringify(value.playlist.mood) ||
    JSON.stringify(value.preferences) !== JSON.stringify(value.playlist.preferences)
  ) {
    return failure("invalid-input");
  }

  try {
    const existing = await deps.getPhotoResultBySaveId(user.id, value.saveId);
    if (existing) {
      deps.releaseUpload(value.uploadHandle);
      return { ok: true, id: existing.id, created: false };
    }
  } catch (error) {
    if (error instanceof PhotoResultError) return failure("unavailable");
    console.error("Could not check saved-result idempotency.");
    return failure("unavailable");
  }

  const uploaded = deps.consumeUpload(value.uploadHandle);
  if (!uploaded) return failure("upload-expired");

  let storageKey: string;
  let palette;
  try {
    palette = await deps.extractPalette(uploaded.bytes);
    storageKey = await deps.uploadPhoto({
      userId: user.id,
      body: uploaded.bytes,
      contentType: uploaded.mimeType,
    });
  } catch (error) {
    if (error instanceof PaletteError || error instanceof StorageError) return failure("unavailable");
    console.error("Could not upload a saved photo.");
    return failure("unavailable");
  }

  try {
    const saved = await deps.savePhotoResult(user.id, {
      saveId: value.saveId,
      storageKey,
      mood: value.mood,
      moodCorrected: value.moodCorrected,
      palette,
      preferences: value.preferences,
      playlist: value.playlist,
    });
    if (!saved.created) {
      try {
        await deps.deletePhoto(storageKey);
      } catch {
        console.error("Could not clean up a duplicate saved photo.");
      }
    }
    return { ok: true, id: saved.id, created: saved.created };
  } catch (error) {
    try {
      await deps.deletePhoto(storageKey);
    } catch {
      console.error("Could not clean up an unsaved photo.");
    }
    if (error instanceof PhotoResultError) return failure("unavailable");
    console.error("Could not save a photo result.");
    return failure("unavailable");
  }
}
