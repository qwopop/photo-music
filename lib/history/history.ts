import "server-only";

import { getCurrentUser } from "../auth";
import { PhotoResultError, deletePhotoResult, getPhotoResult, listPhotoResults } from "../db/photo-results";
import { deletePhoto, getSignedPhotoUrl } from "../storage";

export type HistoryState =
  | { kind: "guest" }
  | { kind: "ready"; items: { id: string; storageKey: string; createdAt: Date; primaryEmotion: string; imageUrl: string | null }[] }
  | { kind: "unavailable" };

export interface HistoryDependencies {
  getCurrentUser: typeof getCurrentUser;
  listPhotoResults: typeof listPhotoResults;
  getPhotoResult: typeof getPhotoResult;
  deletePhotoResult: typeof deletePhotoResult;
  getSignedPhotoUrl: typeof getSignedPhotoUrl;
  deletePhoto: typeof deletePhoto;
}

const defaults: HistoryDependencies = {
  getCurrentUser,
  listPhotoResults,
  getPhotoResult,
  deletePhotoResult,
  getSignedPhotoUrl,
  deletePhoto,
};

export async function loadHistory(deps: HistoryDependencies = defaults): Promise<HistoryState> {
  let user;
  try {
    user = await deps.getCurrentUser();
  } catch {
    return { kind: "unavailable" };
  }
  if (!user) return { kind: "guest" };

  try {
    const { items } = await deps.listPhotoResults(user.id);
    return {
      kind: "ready",
      items: await Promise.all(
        items.map(async (item) => {
          let imageUrl: string | null = null;
          try {
            imageUrl = await deps.getSignedPhotoUrl(item.storageKey);
          } catch {
            // One inaccessible object should not take down the whole page.
          }
          return { ...item, imageUrl };
        }),
      ),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export type SavedResultState =
  | { kind: "guest" | "not-found" | "unavailable" }
  | { kind: "ready"; result: NonNullable<Awaited<ReturnType<typeof getPhotoResult>>>; imageUrl: string | null };

export async function loadSavedResult(id: string, deps: HistoryDependencies = defaults): Promise<SavedResultState> {
  let user;
  try {
    user = await deps.getCurrentUser();
  } catch {
    return { kind: "unavailable" };
  }
  if (!user) return { kind: "guest" };

  try {
    const result = await deps.getPhotoResult(user.id, id);
    if (!result) return { kind: "not-found" };
    let imageUrl: string | null = null;
    try {
      imageUrl = await deps.getSignedPhotoUrl(result.storageKey);
    } catch {
      // Saved result text remains useful if its private object cannot be signed.
    }
    return { kind: "ready", result, imageUrl };
  } catch (error) {
    return error instanceof PhotoResultError ? { kind: "unavailable" } : { kind: "unavailable" };
  }
}

export type DeleteSavedResultState =
  | { ok: true; deleted: boolean; storageCleanupPending: boolean }
  | { ok: false; code: "unauthorized" | "unavailable" };

export interface DeleteResultDependencies {
  getCurrentUser: typeof getCurrentUser;
  deletePhotoResult: typeof deletePhotoResult;
  deletePhoto: typeof deletePhoto;
}

const deleteDefaults: DeleteResultDependencies = {
  getCurrentUser,
  deletePhotoResult,
  deletePhoto,
};

export async function deleteSavedResult(
  id: string,
  deps: DeleteResultDependencies = deleteDefaults,
): Promise<DeleteSavedResultState> {
  let user;
  try {
    user = await deps.getCurrentUser();
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if (!user) return { ok: false, code: "unauthorized" };

  let storageKey: string | null;
  try {
    storageKey = await deps.deletePhotoResult(user.id, id);
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if (!storageKey) return { ok: true, deleted: false, storageCleanupPending: false };

  try {
    await deps.deletePhoto(storageKey);
    return { ok: true, deleted: true, storageCleanupPending: false };
  } catch {
    console.error("Saved photo object cleanup pending for key:", storageKey);
    return { ok: true, deleted: true, storageCleanupPending: true };
  }
}
