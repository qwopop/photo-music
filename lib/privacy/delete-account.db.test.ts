import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { getDb, closeDb } from "../db";
import { users, sessions } from "../db/schema";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { savePhotoResult } from "../db/photo-results";
import { deleteAccount } from "./delete-account";

const testUrl = inject("testDatabaseUrl");

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testUrl);
  getDb();
});
beforeEach(async () => {
  await getDb().delete(users);
});
afterAll(async () => {
  await closeDb();
  vi.unstubAllEnvs();
});

describe("account deletion with saved data", () => {
  it("removes owned database rows and storage objects but retains another user's data", async () => {
    const [owner] = await getDb().insert(users).values({ email: "delete-owner@example.com", passwordHash: "test-hash" }).returning();
    const [other] = await getDb().insert(users).values({ email: "delete-other@example.com", passwordHash: "test-hash" }).returning();
    const ownerKey = `users/${owner.id}/photo.jpg`;
    const otherKey = `users/${other.id}/photo.jpg`;
    const input = (storageKey: string) => ({
      saveId: "828b4289-877e-46a8-9cfb-488c8d1c226b",
      storageKey,
      mood: MOOD_EXAMPLES[0],
      moodCorrected: false,
      palette: { colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"], brightness: 0.5 },
      preferences: PLAYLIST_EXAMPLES[0].preferences,
      playlist: PLAYLIST_EXAMPLES[0],
    });
    const ownerSaved = await savePhotoResult(owner.id, input(ownerKey));
    const otherSaved = await savePhotoResult(other.id, input(otherKey));
    await getDb().insert(sessions).values({
      id: "session-hash-for-owner",
      userId: owner.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const objects = new Set([ownerKey, otherKey]);
    const deleteUserPhotos = vi.fn(async (userId: string) => {
      for (const key of [...objects]) if (key.startsWith(`users/${userId}/`)) objects.delete(key);
      return 1;
    });

    const result = await deleteAccount({
      getCurrentUser: vi.fn(async () => ({ id: owner.id, email: owner.email })),
      deleteUserPhotos,
      async deleteUser(userId) {
        const [deleted] = await getDb().delete(users).where(eq(users.id, userId)).returning({ id: users.id });
        return Boolean(deleted);
      },
    });

    expect(result).toEqual({ ok: true });
    expect(deleteUserPhotos).toHaveBeenCalledWith(owner.id);
    expect(objects).toEqual(new Set([otherKey]));
    expect(await getDb().select().from(users)).toHaveLength(1);
    expect(await getDb().select().from(sessions)).toHaveLength(0);
    expect(await getDb().select().from(users).where(eq(users.id, other.id))).toHaveLength(1);
    expect(await getDb().select().from(users).where(eq(users.id, owner.id))).toHaveLength(0);
    expect(ownerSaved.created).toBe(true);
    expect(otherSaved.created).toBe(true);
    for (const table of ["photos", "analyses", "playlists", "playlist_tracks"]) {
      const { rows } = await getDb().$client.query(`select count(*)::int as count from ${table}`);
      expect(rows[0].count).toBe(table === "photos" ? 1 : table === "analyses" || table === "playlists" ? 1 : 3);
    }
  });
});
