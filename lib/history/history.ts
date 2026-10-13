/**
 * Logic behind the history pages and the delete action. Server-only.
 *
 * The user comes only from `getCurrentUser()`, called first: a guest gets
 * "unauthorized" and nothing is read or deleted. Ownership is checked in SQL by
 * the repository. An unknown id and another user's id give the same
 * "not-found". Shows saved data only: no vision API, no recommendation engine.
 *
 * Errors in outcomes carry fixed text; storage keys (not secrets) may be
 * logged, error messages from storage or Drizzle never are.
 */
import "server-only";

import { getCurrentUser } from "../auth";
import {
  deletePhotoResult,
  getPhotoResult,
  listPhotoResults,
  type PhotoResult,
  type PhotoResultPage,
} from "../db/photo-results";
import type { PrimaryEmotion } from "../mood";
import { deletePhoto, getSignedPhotoUrl } from "../storage";

export const HISTORY_URL_LIFETIME_SECONDS = 300;

/** Moods are interpretations, so they are worded as "Looks ...". */
export function moodLabel(emotion: PrimaryEmotion): string {
  return `Looks ${emotion}`;
}

export interface HistoryDeps {
  getCurrentUser: () => Promise<{ id: string } | null>;
  listPhotoResults: (userId: string) => Promise<PhotoResultPage>;
  getPhotoResult: (userId: string, id: string) => Promise<PhotoResult | null>;
  deletePhotoResult: (userId: string, id: string) => Promise<string | null>;
  getSignedPhotoUrl: (key: string, options: { expiresInSeconds: number }) => Promise<string>;
  deletePhoto: (key: string) => Promise<void>;
  /** Records a storage object that could not be deleted, for a later retry. */
  recordOrphan: (key: string) => void;
}

const defaultDeps: HistoryDeps = {
  getCurrentUser,
  listPhotoResults: (userId) => listPhotoResults(userId),
  getPhotoResult: (userId, id) => getPhotoResult(userId, id),
  deletePhotoResult: (userId, id) => deletePhotoResult(userId, id),
  getSignedPhotoUrl: (key, options) => getSignedPhotoUrl(key, options),
  deletePhoto: (key) => deletePhoto(key),
  recordOrphan: (key) => console.error(`Storage delete failed after the row was deleted; retry deleting key: ${key}`),
};

/** A signed URL, or null when signing fails (the page shows a placeholder). */
async function sign(deps: HistoryDeps, key: string): Promise<string | null> {
  try {
    return await deps.getSignedPhotoUrl(key, { expiresInSeconds: HISTORY_URL_LIFETIME_SECONDS });
  } catch {
    return null;
  }
}

export interface HistoryItem {
  id: string;
  createdAt: Date;
  label: string;
  photoUrl: string | null;
}

export type HistoryList = { status: "unauthorized" } | { status: "ok"; items: HistoryItem[] };

export async function loadHistory(deps: HistoryDeps = defaultDeps): Promise<HistoryList> {
  const user = await deps.getCurrentUser();
  if (!user) return { status: "unauthorized" };
  const page = await deps.listPhotoResults(user.id);
  const items = await Promise.all(
    page.items.map(async (item) => ({
      id: item.id,
      createdAt: item.createdAt,
      label: moodLabel(item.primaryEmotion),
      photoUrl: await sign(deps, item.storageKey),
    })),
  );
  return { status: "ok", items };
}

export type HistoryDetail =
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "ok"; result: PhotoResult; photoUrl: string | null };

export async function loadHistoryItem(id: string, deps: HistoryDeps = defaultDeps): Promise<HistoryDetail> {
  const user = await deps.getCurrentUser();
  if (!user) return { status: "unauthorized" };
  const result = await deps.getPhotoResult(user.id, id);
  if (!result) return { status: "not-found" };
  return { status: "ok", result, photoUrl: await sign(deps, result.storageKey) };
}

export type DeleteOutcome =
  | { status: "deleted" }
  | { status: "unauthorized" | "not-found" | "error"; message: string };

const FAILURES = {
  unauthorized: "Sign in to delete photos.",
  "not-found": "This photo was not found. It may already be deleted.",
  error: "Deleting failed. Please try again.",
} as const;

const failure = (status: keyof typeof FAILURES): DeleteOutcome => ({ status, message: FAILURES[status] });

/**
 * Deletes the row (cascading), then the storage object. If the database delete
 * fails nothing is removed. If the storage delete fails afterwards the user
 * still sees success and the key is recorded for a retry.
 */
export async function deleteHistoryItem(id: string, deps: HistoryDeps = defaultDeps): Promise<DeleteOutcome> {
  let userId: string;
  try {
    const user = await deps.getCurrentUser();
    if (!user) return failure("unauthorized");
    userId = user.id;
  } catch {
    return failure("error");
  }
  let key: string | null;
  try {
    key = await deps.deletePhotoResult(userId, id);
  } catch {
    return failure("error");
  }
  if (key === null) return failure("not-found");
  try {
    await deps.deletePhoto(key);
  } catch {
    deps.recordOrphan(key);
  }
  return { status: "deleted" };
}
