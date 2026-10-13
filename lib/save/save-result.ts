/**
 * Saves a result (photo, mood, palette, playlist, preferences) to a signed-in
 * user's history. Server-only.
 *
 * The user comes only from `getCurrentUser()`, called first. A guest gets an
 * "unauthorized" outcome and nothing is read, uploaded or written. The photo
 * bytes come from the temporary server-side upload store by handle; the mood,
 * playlist and preferences are validated here, never trusted from the client.
 *
 * Order: upload to storage, then `savePhotoResult`. If the database write
 * fails the uploaded object is deleted (best effort). Saving the same
 * `saveId` again yields the same result and leaves one photo and one object.
 *
 * Errors in the outcome carry fixed text only: never a storage or Drizzle
 * error message.
 */
import "server-only";

import { getCurrentUser } from "../auth";
import { savePhotoResult, type SavePhotoResultInput } from "../db/photo-results";
import { moodResultSchema } from "../mood";
import { extractPalette, type PaletteResult } from "../palette";
import { playlistSchema } from "../playlist";
import { preferencesSchema } from "../preferences";
import { deletePhoto, uploadPhoto } from "../storage";
import { uploadStore, type ConsumedUpload } from "../upload/store";
import { z } from "zod";

export type SaveErrorCode = "unauthorized" | "auth-unavailable" | "invalid-input" | "photo-unavailable" | "failed";

export type SaveOutcome =
  | { status: "saved"; id: string }
  | { status: "error"; code: SaveErrorCode; message: string };

const MESSAGES: Record<SaveErrorCode, string> = {
  unauthorized: "Sign in to save results to your history.",
  "auth-unavailable": "We could not check your sign-in right now. Please try again.",
  "invalid-input": "This result could not be saved because it is not valid.",
  "photo-unavailable": "This photo is no longer available, please upload it again.",
  failed: "Saving failed. Please try again.",
};

const fail = (code: SaveErrorCode): SaveOutcome => ({ status: "error", code, message: MESSAGES[code] });

export interface SaveResultInput {
  uploadHandle: string;
  saveId: string;
  mood: unknown;
  moodCorrected: boolean;
  playlist: unknown;
  preferences: unknown;
}

const inputSchema = z.object({
  uploadHandle: z.string().min(1).max(256),
  saveId: z.uuid(),
  mood: moodResultSchema,
  moodCorrected: z.boolean(),
  playlist: playlistSchema,
  preferences: preferencesSchema,
});

export interface SaveDeps {
  getCurrentUser: () => Promise<{ id: string } | null>;
  uploads: { peek(id: string): ConsumedUpload | undefined; release(id: string): void };
  uploadPhoto: (input: { userId: string; body: Uint8Array; contentType: string }) => Promise<string>;
  deletePhoto: (key: string) => Promise<void>;
  extractPalette: (bytes: Buffer) => Promise<PaletteResult>;
  savePhotoResult: (userId: string, input: SavePhotoResultInput) => Promise<{ id: string; created: boolean }>;
}

const defaultDeps: SaveDeps = {
  getCurrentUser,
  uploads: uploadStore,
  uploadPhoto: (input) => uploadPhoto(input),
  deletePhoto: (key) => deletePhoto(key),
  extractPalette,
  savePhotoResult: (userId, input) => savePhotoResult(userId, input),
};

// Concurrent and repeated calls for one (user, saveId) share one run. Failures
// are forgotten so that a retry works; successes are remembered (bounded).
const MAX_REMEMBERED = 500;
const runs = new Map<string, Promise<SaveOutcome>>();

function remember(key: string, run: Promise<SaveOutcome>): void {
  runs.set(key, run);
  if (runs.size > MAX_REMEMBERED) runs.delete(runs.keys().next().value as string);
  void run.then((outcome) => {
    if (outcome.status !== "saved" && runs.get(key) === run) runs.delete(key);
  });
}

/** Test helper: forgets remembered saves. */
export function resetSaveRuns(): void {
  runs.clear();
}

export async function saveResult(input: SaveResultInput, deps: SaveDeps = defaultDeps): Promise<SaveOutcome> {
  let user: { id: string } | null;
  try {
    user = await deps.getCurrentUser();
  } catch {
    return fail("auth-unavailable");
  }
  if (!user) return fail("unauthorized");

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail("invalid-input");

  const key = `${user.id}:${parsed.data.saveId}`;
  const existing = runs.get(key);
  if (existing) return existing;
  const run = perform(user.id, parsed.data, deps);
  remember(key, run);
  return run;
}

async function perform(userId: string, data: z.infer<typeof inputSchema>, deps: SaveDeps): Promise<SaveOutcome> {
  const photo = deps.uploads.peek(data.uploadHandle);
  if (!photo) return fail("photo-unavailable");

  let palette: PaletteResult;
  try {
    palette = await deps.extractPalette(photo.bytes);
  } catch {
    return fail("failed");
  }

  let storageKey: string;
  try {
    storageKey = await deps.uploadPhoto({ userId, body: photo.bytes, contentType: photo.mimeType });
  } catch {
    return fail("failed"); // nothing is written to the database
  }

  let saved: { id: string; created: boolean };
  try {
    saved = await deps.savePhotoResult(userId, {
      saveId: data.saveId,
      storageKey,
      mood: data.mood,
      moodCorrected: data.moodCorrected,
      palette,
      preferences: data.preferences,
      playlist: data.playlist,
    });
  } catch {
    await deps.deletePhoto(storageKey).catch(() => undefined);
    return fail("failed");
  }
  if (!saved.created) {
    // An earlier save of this saveId already stored a photo: keep one object.
    await deps.deletePhoto(storageKey).catch(() => undefined);
  }
  deps.uploads.release(data.uploadHandle);
  return { status: "saved", id: saved.id };
}
