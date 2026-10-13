import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { connectionSettings } from "../db/connection";
import type { Database } from "../db";
import { deletePhotoResult, getPhotoResult, listPhotoResults, savePhotoResult } from "../db/photo-results";
import * as schema from "../db/schema";
import { users } from "../db/schema";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import { deleteHistoryItem, loadHistory, loadHistoryItem, type HistoryDeps } from "./history";

// Runs with `npm run test:db`: the history logic against the real repository.

const pool = new Pool(connectionSettings({ url: inject("testDatabaseUrl") }));
const db = drizzle({ client: pool, schema }) as Database;

beforeEach(async () => {
  await db.delete(users);
});
afterAll(() => pool.end());

async function newUser(email: string): Promise<string> {
  const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning({ id: users.id });
  return user.id;
}

function depsFor(userId: string | null): HistoryDeps & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    getCurrentUser: async () => (userId ? { id: userId } : null),
    listPhotoResults: (u) => listPhotoResults(u, {}, db),
    getPhotoResult: (u, id) => getPhotoResult(u, id, db),
    deletePhotoResult: (u, id) => deletePhotoResult(u, id, db),
    getSignedPhotoUrl: async (key) => `https://signed.example/${key}`,
    deletePhoto: async (key) => void deleted.push(key),
    recordOrphan: vi.fn(),
  };
}

async function seed(userId: string) {
  return savePhotoResult(
    userId,
    {
      saveId: randomUUID(),
      storageKey: `users/${userId}/${randomUUID()}.jpg`,
      mood: MOOD_EXAMPLES[0],
      moodCorrected: false,
      palette: { colors: ["#112233"], brightness: 0.4 },
      preferences: DEFAULT_PREFERENCES,
      playlist: PLAYLIST_EXAMPLES[0],
    },
    db,
  );
}

describe("history access rules", () => {
  it("guest: no data read, view and delete refused", async () => {
    const owner = await newUser("a@example.com");
    const { id } = await seed(owner);
    const guest = depsFor(null);
    expect(await loadHistory(guest)).toEqual({ status: "unauthorized" });
    expect(await loadHistoryItem(id, guest)).toEqual({ status: "unauthorized" });
    expect(await deleteHistoryItem(id, guest)).toMatchObject({ status: "unauthorized" });
    expect(await getPhotoResult(owner, id, db)).not.toBeNull();
  });

  it("owner: lists, views and deletes (cascading) with the object removed", async () => {
    const owner = await newUser("a@example.com");
    const { id } = await seed(owner);
    const deps = depsFor(owner);
    expect(await loadHistory(deps)).toMatchObject({ status: "ok", items: [{ id, label: "Looks happy" }] });
    expect(await loadHistoryItem(id, deps)).toMatchObject({ status: "ok", result: { id } });
    expect(await deleteHistoryItem(id, deps)).toEqual({ status: "deleted" });
    expect(deps.deleted).toHaveLength(1);
    expect(await loadHistory(deps)).toEqual({ status: "ok", items: [] });
    expect(await db.select().from(schema.playlistTracks)).toHaveLength(0);
    expect(await deleteHistoryItem(id, deps)).toMatchObject({ status: "not-found" });
  });

  it("other user: not-found for view and delete, nothing changes", async () => {
    const owner = await newUser("a@example.com");
    const other = await newUser("b@example.com");
    const { id } = await seed(owner);
    const deps = depsFor(other);
    expect(await loadHistoryItem(id, deps)).toEqual({ status: "not-found" });
    expect(await deleteHistoryItem(id, deps)).toMatchObject({ status: "not-found" });
    expect(deps.deleted).toHaveLength(0);
    expect(await loadHistory(deps)).toEqual({ status: "ok", items: [] });
    expect(await getPhotoResult(owner, id, db)).not.toBeNull();
  });

  it("unknown id: same not-found as another user's id", async () => {
    const owner = await newUser("a@example.com");
    const deps = depsFor(owner);
    const unknown = randomUUID();
    expect(await loadHistoryItem(unknown, deps)).toEqual({ status: "not-found" });
    expect(await deleteHistoryItem(unknown, deps)).toMatchObject({ status: "not-found" });
  });
});
