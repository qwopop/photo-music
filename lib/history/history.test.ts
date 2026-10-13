import { describe, expect, it, vi } from "vitest";
import type { PhotoResult } from "../db/photo-results";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import { deleteHistoryItem, loadHistory, loadHistoryItem, moodLabel, type HistoryDeps } from "./history";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

function result(id: string, key: string): PhotoResult {
  return {
    id,
    storageKey: key,
    createdAt: new Date("2026-01-02T00:00:00Z"),
    mood: MOOD_EXAMPLES[2],
    moodCorrected: false,
    palette: { colors: ["#000000"], brightness: 0.5 },
    preferences: DEFAULT_PREFERENCES,
    playlist: PLAYLIST_EXAMPLES[0],
  };
}

function setup(user: { id: string } | null = { id: OWNER }, overrides: Partial<HistoryDeps> = {}) {
  const rows = new Map([[ID, { userId: OWNER, key: `users/${OWNER}/a.jpg` }]]);
  const deps: HistoryDeps = {
    getCurrentUser: vi.fn(async () => user),
    listPhotoResults: vi.fn(async (userId) => ({
      items: [...rows].filter(([, r]) => r.userId === userId).map(([id, r]) => ({ id, storageKey: r.key, createdAt: new Date("2026-01-02T00:00:00Z"), primaryEmotion: "calm" as const })),
      nextCursor: null,
    })),
    getPhotoResult: vi.fn(async (userId, id) => {
      const r = rows.get(id);
      return r && r.userId === userId ? result(id, r.key) : null;
    }),
    deletePhotoResult: vi.fn(async (userId, id) => {
      const r = rows.get(id);
      if (!r || r.userId !== userId) return null;
      rows.delete(id);
      return r.key;
    }),
    getSignedPhotoUrl: vi.fn(async (key) => `https://signed.example/${key}?sig=x`),
    deletePhoto: vi.fn(async () => undefined),
    recordOrphan: vi.fn(),
    ...overrides,
  };
  return { deps, rows };
}

describe("moodLabel", () => {
  it("words the mood as an interpretation", () => expect(moodLabel("calm")).toBe("Looks calm"));
});

describe("loadHistory", () => {
  it("reads nothing for a guest", async () => {
    const { deps } = setup(null);
    expect(await loadHistory(deps)).toEqual({ status: "unauthorized" });
    expect(deps.listPhotoResults).not.toHaveBeenCalled();
    expect(deps.getSignedPhotoUrl).not.toHaveBeenCalled();
  });

  it("lists the user's items with short-lived signed urls", async () => {
    const { deps } = setup();
    const list = await loadHistory(deps);
    expect(list).toMatchObject({ status: "ok", items: [{ id: ID, label: "Looks calm", photoUrl: expect.stringContaining("signed.example") }] });
    expect(deps.getSignedPhotoUrl).toHaveBeenCalledWith(expect.any(String), { expiresInSeconds: 300 });
  });

  it("shows nothing for another user and an empty list for a new user", async () => {
    expect(await loadHistory(setup({ id: OTHER }).deps)).toEqual({ status: "ok", items: [] });
  });

  it("uses a placeholder when signing fails", async () => {
    const { deps } = setup(undefined, { getSignedPhotoUrl: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await loadHistory(deps)).toMatchObject({ status: "ok", items: [{ id: ID, photoUrl: null }] });
  });
});

describe("loadHistoryItem", () => {
  it("redirects a guest without reading", async () => {
    const { deps } = setup(null);
    expect(await loadHistoryItem(ID, deps)).toEqual({ status: "unauthorized" });
    expect(deps.getPhotoResult).not.toHaveBeenCalled();
  });
  it("returns the saved result for the owner", async () => {
    const detail = await loadHistoryItem(ID, setup().deps);
    expect(detail).toMatchObject({ status: "ok", result: { id: ID }, photoUrl: expect.any(String) });
  });
  it("gives the same not-found for another user's and an unknown id", async () => {
    const other = await loadHistoryItem(ID, setup({ id: OTHER }).deps);
    const unknown = await loadHistoryItem("44444444-4444-4444-8444-444444444444", setup().deps);
    expect(other).toEqual({ status: "not-found" });
    expect(unknown).toEqual(other);
  });
  it("still renders when signing fails", async () => {
    const { deps } = setup(undefined, { getSignedPhotoUrl: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await loadHistoryItem(ID, deps)).toMatchObject({ status: "ok", photoUrl: null });
  });
});

describe("deleteHistoryItem", () => {
  it("does nothing for a guest", async () => {
    const { deps, rows } = setup(null);
    expect(await deleteHistoryItem(ID, deps)).toMatchObject({ status: "unauthorized" });
    expect(deps.deletePhotoResult).not.toHaveBeenCalled();
    expect(rows.size).toBe(1);
  });
  it("deletes the row then the object for the owner, and a repeat is not-found", async () => {
    const { deps, rows } = setup();
    expect(await deleteHistoryItem(ID, deps)).toEqual({ status: "deleted" });
    expect(deps.deletePhoto).toHaveBeenCalledWith(`users/${OWNER}/a.jpg`);
    expect(rows.size).toBe(0);
    expect(await deleteHistoryItem(ID, deps)).toMatchObject({ status: "not-found" });
    expect(deps.deletePhoto).toHaveBeenCalledTimes(1);
  });
  it("changes nothing for another user or an unknown id", async () => {
    const { deps, rows } = setup({ id: OTHER });
    expect(await deleteHistoryItem(ID, deps)).toMatchObject({ status: "not-found" });
    expect(await deleteHistoryItem("not-a-uuid", deps)).toMatchObject({ status: "not-found" });
    expect(rows.size).toBe(1);
    expect(deps.deletePhoto).not.toHaveBeenCalled();
  });
  it("reports success and records the key when the storage delete fails", async () => {
    const { deps, rows } = setup(undefined, { deletePhoto: vi.fn(async () => { throw new Error("secret-ish"); }) });
    expect(await deleteHistoryItem(ID, deps)).toEqual({ status: "deleted" });
    expect(deps.recordOrphan).toHaveBeenCalledWith(`users/${OWNER}/a.jpg`);
    expect(rows.size).toBe(0);
  });
  it("removes nothing when the database delete fails", async () => {
    const { deps } = setup(undefined, { deletePhotoResult: vi.fn(async () => { throw new Error("db"); }) });
    const outcome = await deleteHistoryItem(ID, deps);
    expect(outcome).toMatchObject({ status: "error", message: "Deleting failed. Please try again." });
    expect(deps.deletePhoto).not.toHaveBeenCalled();
  });
});
