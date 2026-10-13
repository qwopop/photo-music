import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { SaveResultDependencies, saveResult } from "./save-result";

const user = { id: "7a93c9ab-8389-48a0-a854-f063bb18406d", email: "user@example.com" };
const input = {
  uploadHandle: "opaque-upload-handle",
  saveId: "828b4289-877e-46a8-9cfb-488c8d1c226b",
  mood: MOOD_EXAMPLES[0],
  moodCorrected: false,
  preferences: PLAYLIST_EXAMPLES[0].preferences,
  playlist: PLAYLIST_EXAMPLES[0],
};

function fakes(overrides: Partial<SaveResultDependencies> = {}) {
  const deps: SaveResultDependencies = {
    getCurrentUser: vi.fn(async () => user),
    consumeUpload: vi.fn(() => ({ bytes: Buffer.from("photo"), mimeType: "image/jpeg" as const, size: 5 })),
    releaseUpload: vi.fn(),
    extractPalette: vi.fn(async () => ({
      colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"],
      brightness: 0.5,
    })),
    uploadPhoto: vi.fn(async () => `users/${user.id}/stored.jpg`),
    deletePhoto: vi.fn(async () => undefined),
    getPhotoResultBySaveId: vi.fn(async () => null),
    savePhotoResult: vi.fn(async () => ({ id: "4b2d0a99-8e6b-4d2d-9997-d134ca9f82df", created: true })),
    ...overrides,
  };
  return deps;
}

describe("saveResult", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("checks the current user first and stores nothing for a guest", async () => {
    const deps = fakes({ getCurrentUser: vi.fn(async () => null) });
    expect(await saveResult(input, deps)).toMatchObject({ ok: false, code: "unauthorized" });
    expect(deps.getCurrentUser).toHaveBeenCalledOnce();
    expect(deps.getPhotoResultBySaveId).not.toHaveBeenCalled();
    expect(deps.consumeUpload).not.toHaveBeenCalled();
    expect(deps.uploadPhoto).not.toHaveBeenCalled();
    expect(deps.savePhotoResult).not.toHaveBeenCalled();
  });

  it("uploads privately and saves the validated result once", async () => {
    const deps = fakes();
    expect(await saveResult(input, deps)).toEqual({
      ok: true,
      id: "4b2d0a99-8e6b-4d2d-9997-d134ca9f82df",
      created: true,
    });
    expect(deps.uploadPhoto).toHaveBeenCalledWith({
      userId: user.id,
      body: Buffer.from("photo"),
      contentType: "image/jpeg",
    });
    expect(deps.savePhotoResult).toHaveBeenCalledWith(user.id, expect.objectContaining({
      saveId: input.saveId,
      storageKey: `users/${user.id}/stored.jpg`,
      mood: input.mood,
      playlist: input.playlist,
    }));
    expect(deps.consumeUpload).toHaveBeenCalledOnce();
  });

  it("returns the existing row and releases the handle on an idempotent retry", async () => {
    const deps = fakes({
      getPhotoResultBySaveId: vi.fn(async () => ({ id: "4b2d0a99-8e6b-4d2d-9997-d134ca9f82df", storageKey: "users/id/photo.jpg" })),
    });
    expect(await saveResult(input, deps)).toEqual({
      ok: true,
      id: "4b2d0a99-8e6b-4d2d-9997-d134ca9f82df",
      created: false,
    });
    expect(deps.releaseUpload).toHaveBeenCalledWith(input.uploadHandle);
    expect(deps.consumeUpload).not.toHaveBeenCalled();
    expect(deps.uploadPhoto).not.toHaveBeenCalled();
    expect(deps.savePhotoResult).not.toHaveBeenCalled();
  });

  it("reports an expired upload without storage or database writes", async () => {
    const deps = fakes({ consumeUpload: vi.fn(() => undefined) });
    expect(await saveResult(input, deps)).toMatchObject({ ok: false, code: "upload-expired" });
    expect(deps.uploadPhoto).not.toHaveBeenCalled();
    expect(deps.savePhotoResult).not.toHaveBeenCalled();
  });

  it("removes an uploaded object if the database write fails", async () => {
    const deps = fakes({ savePhotoResult: vi.fn(async () => { throw new Error("SQL included private parameters"); }) });
    expect(await saveResult(input, deps)).toMatchObject({ ok: false, code: "unavailable" });
    expect(deps.deletePhoto).toHaveBeenCalledWith(`users/${user.id}/stored.jpg`);
  });

  it("rejects malformed and internally inconsistent inputs before touching upload state", async () => {
    const deps = fakes();
    expect(await saveResult({ ...input, extra: true }, deps)).toMatchObject({ ok: false, code: "invalid-input" });
    expect(await saveResult({ ...input, mood: MOOD_EXAMPLES[1] }, deps)).toMatchObject({ ok: false, code: "invalid-input" });
    expect(deps.consumeUpload).not.toHaveBeenCalled();
    expect(deps.uploadPhoto).not.toHaveBeenCalled();
  });

  it("does not expose provider or database messages in user-visible state", async () => {
    const deps = fakes({
      getPhotoResultBySaveId: vi.fn(async () => { throw new Error("secret SQL parameters"); }),
    });
    const result = await saveResult(input, deps);
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret SQL parameters");
  });
});
