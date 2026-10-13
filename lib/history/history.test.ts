import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { HistoryDependencies, DeleteResultDependencies, loadHistory, loadSavedResult, deleteSavedResult } from "./history";

const user = { id: "7a93c9ab-8389-48a0-a854-f063bb18406d", email: "user@example.com" };
const result = {
  id: "828b4289-877e-46a8-9cfb-488c8d1c226b",
  storageKey: `users/${user.id}/photo.jpg`,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  mood: MOOD_EXAMPLES[0],
  moodCorrected: false,
  palette: { colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"], brightness: 0.5 },
  preferences: PLAYLIST_EXAMPLES[0].preferences,
  playlist: PLAYLIST_EXAMPLES[0],
};

function historyDeps(overrides: Partial<HistoryDependencies> = {}): HistoryDependencies {
  return {
    getCurrentUser: vi.fn(async () => user),
    listPhotoResults: vi.fn(async () => ({
      items: [{ id: result.id, storageKey: result.storageKey, createdAt: result.createdAt, primaryEmotion: "calm" }],
      nextCursor: null,
    })),
    getPhotoResult: vi.fn(async () => result),
    deletePhotoResult: vi.fn(async () => result.storageKey),
    getSignedPhotoUrl: vi.fn(async (key: string) => `https://signed.example/${encodeURIComponent(key)}`),
    deletePhoto: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("history page logic", () => {
  it("rejects guests before listing saved items", async () => {
    const deps = historyDeps({ getCurrentUser: vi.fn(async () => null) });
    expect(await loadHistory(deps)).toEqual({ kind: "guest" });
    expect(deps.listPhotoResults).not.toHaveBeenCalled();
  });

  it("returns each item with a short-lived signed URL and keeps rendering if one cannot be signed", async () => {
    const deps = historyDeps({
      listPhotoResults: vi.fn(async () => ({
        items: [
          { id: result.id, storageKey: result.storageKey, createdAt: result.createdAt, primaryEmotion: "calm" },
          { id: "another", storageKey: `users/${user.id}/another.jpg`, createdAt: result.createdAt, primaryEmotion: "happy" },
        ],
        nextCursor: null,
      })),
      getSignedPhotoUrl: vi.fn(async (key: string) => {
        if (key.endsWith("another.jpg")) throw new Error("signed URL secret");
        return "https://signed.example/first";
      }),
    });
    const history = await loadHistory(deps);
    expect(history).toMatchObject({
      kind: "ready",
      items: [
        { imageUrl: "https://signed.example/first" },
        { imageUrl: null },
      ],
    });
    expect(deps.getSignedPhotoUrl).toHaveBeenCalledWith(result.storageKey);
  });

  it("does not distinguish another user's result from an unknown id", async () => {
    const ownerMismatch = historyDeps({ getPhotoResult: vi.fn(async () => null) });
    const unknown = historyDeps({ getPhotoResult: vi.fn(async () => null) });
    expect(await loadSavedResult(result.id, ownerMismatch)).toEqual({ kind: "not-found" });
    expect(await loadSavedResult("unknown", unknown)).toEqual({ kind: "not-found" });
  });

  it("reopens only persisted result data and tolerates missing private image signing", async () => {
    const deps = historyDeps({ getSignedPhotoUrl: vi.fn(async () => { throw new Error("sign failed"); }) });
    expect(await loadSavedResult(result.id, deps)).toMatchObject({
      kind: "ready",
      result: { id: result.id, mood: result.mood, playlist: result.playlist },
      imageUrl: null,
    });
    expect(deps.getPhotoResult).toHaveBeenCalledWith(user.id, result.id);
  });
});

describe("saved-result deletion", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("checks signed-in identity before deleting", async () => {
    const deps: DeleteResultDependencies = {
      getCurrentUser: vi.fn(async () => null),
      deletePhotoResult: vi.fn(async () => result.storageKey),
      deletePhoto: vi.fn(async () => undefined),
    };
    expect(await deleteSavedResult(result.id, deps)).toEqual({ ok: false, code: "unauthorized" });
    expect(deps.deletePhotoResult).not.toHaveBeenCalled();
    expect(deps.deletePhoto).not.toHaveBeenCalled();
  });

  it("does not delete storage for another user's or an unknown id", async () => {
    const deps: DeleteResultDependencies = {
      getCurrentUser: vi.fn(async () => user),
      deletePhotoResult: vi.fn(async () => null),
      deletePhoto: vi.fn(async () => undefined),
    };
    expect(await deleteSavedResult(result.id, deps)).toEqual({
      ok: true,
      deleted: false,
      storageCleanupPending: false,
    });
    expect(deps.deletePhoto).not.toHaveBeenCalled();
  });

  it("deletes the owned row then its object and records safe retry data on storage failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps: DeleteResultDependencies = {
      getCurrentUser: vi.fn(async () => user),
      deletePhotoResult: vi.fn(async () => result.storageKey),
      deletePhoto: vi.fn(async () => { throw new Error("secret signed URL"); }),
    };
    expect(await deleteSavedResult(result.id, deps)).toEqual({
      ok: true,
      deleted: true,
      storageCleanupPending: true,
    });
    expect(deps.deletePhotoResult).toHaveBeenCalledWith(user.id, result.id);
    expect(deps.deletePhoto).toHaveBeenCalledWith(result.storageKey);
    expect(error).toHaveBeenCalledWith("Saved photo object cleanup pending for key:", result.storageKey);
    expect(error.mock.calls.flat().join(" ")).not.toContain("secret signed URL");
  });
});
