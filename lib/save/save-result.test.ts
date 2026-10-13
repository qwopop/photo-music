import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import { TemporaryUploadStore } from "../upload/store";
import { resetSaveRuns, saveResult, type SaveDeps, type SaveResultInput } from "./save-result";

const USER = "11111111-1111-4111-8111-111111111111";
const SAVE_ID = "22222222-2222-4222-8222-222222222222";
const bytes = readFileSync("lib/upload/fixtures/sample.jpg");

function setup(overrides: Partial<SaveDeps> = {}) {
  const uploads = new TemporaryUploadStore();
  const handle = uploads.put({ bytes, mimeType: "image/jpeg" }).id;
  const objects = new Set<string>();
  const rows = new Map<string, string>();
  let n = 0;
  const deps: SaveDeps = {
    getCurrentUser: vi.fn(async () => ({ id: USER })),
    uploads,
    uploadPhoto: vi.fn(async ({ userId }) => {
      const key = `users/${userId}/${++n}.jpg`;
      objects.add(key);
      return key;
    }),
    deletePhoto: vi.fn(async (key: string) => void objects.delete(key)),
    extractPalette: vi.fn(async () => ({ colors: ["#000000"], brightness: 0.5 })),
    savePhotoResult: vi.fn(async (_u, input) => {
      const id = rows.get(input.saveId);
      if (id) return { id, created: false };
      rows.set(input.saveId, `row-${rows.size + 1}`);
      return { id: rows.get(input.saveId)!, created: true };
    }),
    ...overrides,
  };
  const input: SaveResultInput = {
    uploadHandle: handle,
    saveId: SAVE_ID,
    mood: MOOD_EXAMPLES[0],
    moodCorrected: false,
    playlist: PLAYLIST_EXAMPLES[0],
    preferences: DEFAULT_PREFERENCES,
  };
  return { deps, input, objects, rows, uploads, handle };
}

beforeEach(() => resetSaveRuns());

describe("saveResult", () => {
  it("rejects a guest and touches neither storage nor the database", async () => {
    const { deps, input, objects, rows } = setup({ getCurrentUser: vi.fn(async () => null) });
    expect(await saveResult(input, deps)).toMatchObject({ status: "error", code: "unauthorized" });
    expect(deps.uploadPhoto).not.toHaveBeenCalled();
    expect(deps.savePhotoResult).not.toHaveBeenCalled();
    expect(objects.size + rows.size).toBe(0);
  });

  it("does not treat an auth failure as a guest", async () => {
    const { deps, input } = setup({ getCurrentUser: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect(await saveResult(input, deps)).toMatchObject({ code: "auth-unavailable" });
  });

  it("uploads then saves for the signed-in user", async () => {
    const { deps, input, objects } = setup();
    const out = await saveResult(input, deps);
    expect(out).toEqual({ status: "saved", id: "row-1" });
    expect(deps.uploadPhoto).toHaveBeenCalledWith({ userId: USER, body: bytes, contentType: "image/jpeg" });
    expect(deps.savePhotoResult).toHaveBeenCalledWith(USER, expect.objectContaining({ saveId: SAVE_ID, storageKey: [...objects][0] }));
  });

  it("gives one upload and one row for concurrent and repeated calls", async () => {
    const { deps, input, objects, rows } = setup();
    const results = await Promise.all([saveResult(input, deps), saveResult(input, deps)]);
    results.push(await saveResult(input, deps));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0].status).toBe("saved");
    expect(deps.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(1);
    expect(rows.size).toBe(1);
  });

  it("keeps one object when the repository reports an existing save", async () => {
    const { deps, input, objects } = setup();
    await saveResult(input, deps);
    resetSaveRuns(); // e.g. another server process
    const again = setup();
    const second = await saveResult({ ...input, uploadHandle: again.handle }, { ...deps, uploads: again.uploads });
    expect(second).toEqual({ status: "saved", id: "row-1" });
    expect(objects.size).toBe(1);
  });

  it("deletes the upload when the database write fails, and a retry works", async () => {
    let fail = true;
    const base = setup();
    const save = base.deps.savePhotoResult;
    const deps = {
      ...base.deps,
      savePhotoResult: vi.fn(async (u: string, i: Parameters<typeof save>[1]) => {
        if (fail) throw new Error("insert into photos values ($1) secret");
        return save(u, i);
      }),
    };
    const out = await saveResult(base.input, deps);
    expect(out).toMatchObject({ status: "error", code: "failed" });
    expect(JSON.stringify(out)).not.toMatch(/secret|insert/);
    expect(deps.deletePhoto).toHaveBeenCalledTimes(1);
    expect(base.objects.size).toBe(0);
    fail = false;
    expect(await saveResult(base.input, deps)).toMatchObject({ status: "saved" });
    expect(base.objects.size).toBe(1);
  });

  it("writes nothing to the database when the upload fails", async () => {
    const { deps, input } = setup({ uploadPhoto: vi.fn(async () => Promise.reject(new Error("AKIA-secret"))) });
    const out = await saveResult(input, deps);
    expect(out).toMatchObject({ code: "failed" });
    expect(JSON.stringify(out)).not.toContain("AKIA");
    expect(deps.savePhotoResult).not.toHaveBeenCalled();
  });

  it("reports an unknown or expired handle and saves nothing", async () => {
    const { deps, input } = setup();
    const out = await saveResult({ ...input, uploadHandle: "nope" }, deps);
    expect(out).toEqual({
      status: "error",
      code: "photo-unavailable",
      message: "This photo is no longer available, please upload it again.",
    });
    expect(deps.uploadPhoto).not.toHaveBeenCalled();

    let now = 0;
    const uploads = new TemporaryUploadStore({ now: () => now, ttlMs: 1000 });
    const handle = uploads.put({ bytes, mimeType: "image/jpeg" }).id;
    now = 2000;
    expect(await saveResult({ ...input, uploadHandle: handle }, { ...deps, uploads })).toMatchObject({ code: "photo-unavailable" });
  });

  it("rejects an invalid mood, playlist, preferences or save id", async () => {
    const { deps, input } = setup();
    const bad = { ...MOOD_EXAMPLES[0], primaryEmotion: "furious" };
    expect(await saveResult({ ...input, mood: bad }, deps)).toMatchObject({ code: "invalid-input" });
    expect(await saveResult({ ...input, playlist: { tracks: [] } }, deps)).toMatchObject({ code: "invalid-input" });
    expect(await saveResult({ ...input, preferences: { genres: ["x"] } }, deps)).toMatchObject({ code: "invalid-input" });
    expect(await saveResult({ ...input, saveId: "not-a-uuid" }, deps)).toMatchObject({ code: "invalid-input" });
    expect(deps.uploadPhoto).not.toHaveBeenCalled();
  });
});
