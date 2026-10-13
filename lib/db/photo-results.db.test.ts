import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { connectionSettings } from "./connection";
import type { Database } from "./index";
import { MOOD_EXAMPLES, moodResultSchema } from "../mood";
import { PLAYLIST_EXAMPLES, playlistSchema } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import { deletePhotoResult, getPhotoResult, listPhotoResults, savePhotoResult, type SavePhotoResultInput } from "./photo-results";
import * as schema from "./schema";
import { analyses, photos, playlists, playlistTracks, sessions, users } from "./schema";

// Runs with `npm run test:db`. The repository gets this run's database injected.

const pool = new Pool(connectionSettings({ url: inject("testDatabaseUrl") }));
const db = drizzle({ client: pool, schema }) as Database;

beforeEach(async () => {
  await db.delete(users);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

async function newUser(email: string): Promise<string> {
  const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning({ id: users.id });
  return user.id;
}

function input(userId: string, overrides: Partial<SavePhotoResultInput> = {}): SavePhotoResultInput {
  return {
    saveId: randomUUID(),
    storageKey: `users/${userId}/${randomUUID()}.jpg`,
    mood: MOOD_EXAMPLES[0],
    moodCorrected: false,
    palette: { colors: ["#112233", "#445566"], brightness: 0.4 },
    preferences: DEFAULT_PREFERENCES,
    playlist: PLAYLIST_EXAMPLES[0],
    ...overrides,
  };
}

async function counts() {
  return [photos, analyses, playlists, playlistTracks].map(async (t) => (await db.select().from(t)).length);
}
async function rowCounts(): Promise<number[]> {
  return Promise.all(await counts());
}

describe("round trip", () => {
  it.each(PLAYLIST_EXAMPLES.map((playlist, i) => [i, playlist] as const))("returns what example %i saved", async (_i, playlist) => {
    const userId = await newUser("a@example.com");
    const data = input(userId, { mood: playlist.mood, playlist, moodCorrected: true });
    const saved = await savePhotoResult(userId, data, db);
    expect(saved.created).toBe(true);
    const result = await getPhotoResult(userId, saved.id, db);
    expect(result).toMatchObject({
      id: saved.id,
      storageKey: data.storageKey,
      mood: data.mood,
      moodCorrected: true,
      palette: data.palette,
      preferences: data.preferences,
      playlist,
    });
    expect(result?.createdAt).toBeInstanceOf(Date);
    expect(moodResultSchema.safeParse(result?.mood).success).toBe(true);
    expect(playlistSchema.safeParse(result?.playlist).success).toBe(true);
    expect(result?.playlist.tracks.map((t) => t.spotifyId)).toEqual(playlist.tracks.map((t) => t.spotifyId));
  });

  it("returns null for an unknown id and another user's id alike", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const { id } = await savePhotoResult(ann, input(ann), db);
    expect(await getPhotoResult(bob, id, db)).toBeNull();
    expect(await getPhotoResult(ann, randomUUID(), db)).toBeNull();
  });

  it("uses getDb() when no database is passed", async () => {
    vi.stubEnv("DATABASE_URL", inject("testDatabaseUrl"));
    const { closeDb } = await import("./index");
    try {
      const userId = await newUser("a@example.com");
      const { id } = await savePhotoResult(userId, input(userId));
      expect((await getPhotoResult(userId, id))?.id).toBe(id);
    } finally {
      await closeDb();
      vi.unstubAllEnvs();
    }
  });
});

describe("idempotency", () => {
  it("returns the existing id with created: false and adds no rows", async () => {
    const userId = await newUser("a@example.com");
    const data = input(userId);
    const first = await savePhotoResult(userId, data, db);
    const second = await savePhotoResult(userId, { ...data, storageKey: `users/${userId}/${randomUUID()}.png` }, db);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await rowCounts()).toEqual([1, 1, 1, 5]);
  });

  it("survives two concurrent calls", async () => {
    const userId = await newUser("a@example.com");
    const data = input(userId);
    const results = await Promise.all([savePhotoResult(userId, data, db), savePhotoResult(userId, data, db)]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await rowCounts()).toEqual([1, 1, 1, 5]);
  });

  it("creates a separate result for the same saveId and another user", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const saveId = randomUUID();
    const a = await savePhotoResult(ann, input(ann, { saveId }), db);
    const b = await savePhotoResult(bob, input(bob, { saveId }), db);
    expect(a.id).not.toBe(b.id);
    expect(b.created).toBe(true);
  });
});

describe("transaction and validation", () => {
  it("rolls everything back when the last insert fails", async () => {
    const userId = await newUser("a@example.com");
    const base = PLAYLIST_EXAMPLES[0];
    const duplicated = { ...base, tracks: [base.tracks[0], { ...base.tracks[1], spotifyId: base.tracks[0].spotifyId }] };
    vi.spyOn(playlistSchema, "parse").mockReturnValue(duplicated);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(savePhotoResult(userId, input(userId), db)).rejects.toMatchObject({ code: "DATABASE_ERROR" });
    expect(await rowCounts()).toEqual([0, 0, 0, 0]);
  });

  it("writes nothing for invalid input", async () => {
    const userId = await newUser("a@example.com");
    await expect(savePhotoResult(userId, input(userId, { storageKey: "" }), db)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await rowCounts()).toEqual([0, 0, 0, 0]);
  });

  it("never exposes the query or its parameters in a database error", async () => {
    const userId = await newUser("a@example.com");
    const first = input(userId);
    await savePhotoResult(userId, first, db);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await savePhotoResult(userId, input(userId, { storageKey: first.storageKey }), db).catch((e: unknown) => e as Error) as Error;
    expect(error).toMatchObject({ name: "PhotoResultError", code: "DATABASE_ERROR" });
    expect(JSON.stringify([error.message, error.cause, logged.mock.calls])).not.toMatch(first.storageKey);
  });
});

describe("listPhotoResults", () => {
  it("lists newest first with the summary fields and never mixes users", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const a1 = await savePhotoResult(ann, input(ann, { mood: MOOD_EXAMPLES[1] }), db);
    const a2 = await savePhotoResult(ann, input(ann), db);
    const b1 = await savePhotoResult(bob, input(bob), db);
    await db.update(photos).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(photos.id, a1.id));
    const page = await listPhotoResults(ann, {}, db);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.id)).toEqual([a2.id, a1.id]);
    expect(page.items[1]).toMatchObject({ primaryEmotion: MOOD_EXAMPLES[1].primaryEmotion, createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(page.items[0].storageKey).toMatch(/^users\//);
    expect((await listPhotoResults(bob, {}, db)).items.map((i) => i.id)).toEqual([b1.id]);
  });

  it("pages without repeats or skips, including equal timestamps", async () => {
    const userId = await newUser("a@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await savePhotoResult(userId, input(userId), db)).id);
    await db.update(photos).set({ createdAt: new Date("2026-01-01T00:00:00Z") });
    // Two with the same microsecond timestamp, a third a microsecond apart.
    await pool.query("update photos set created_at = '2026-02-01 00:00:00.000100+00' where id = $1", [ids[0]]);
    await pool.query("update photos set created_at = '2026-02-01 00:00:00.000200+00' where id = $1", [ids[1]]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPhotoResults(userId, { limit: 2, cursor }, db);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice(0, 2)).toEqual([ids[1], ids[0]]);
    expect(seen.slice(2)).toEqual(ids.slice(2).sort().reverse());
  });

  it("applies the default limit of 20 and a maximum of 100", async () => {
    const userId = await newUser("a@example.com");
    for (let i = 0; i < 21; i++) await savePhotoResult(userId, input(userId), db);
    const page = await listPhotoResults(userId, {}, db);
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    await expect(listPhotoResults(userId, { limit: 101 }, db)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    await expect(listPhotoResults(userId, { limit: 0 }, db)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  });
});

describe("deletion and cascades", () => {
  it("deletes an owned result with its children and returns the storage key", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const data = input(ann);
    const { id } = await savePhotoResult(ann, data, db);
    await savePhotoResult(bob, input(bob), db);
    expect(await deletePhotoResult(bob, id, db)).toBeNull();
    expect(await rowCounts()).toEqual([2, 2, 2, 10]);
    expect(await deletePhotoResult(ann, randomUUID(), db)).toBeNull();
    expect(await deletePhotoResult(ann, id, db)).toBe(data.storageKey);
    expect(await rowCounts()).toEqual([1, 1, 1, 5]);
  });

  it("deleting a user removes their rows in all four tables and keeps others", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    await savePhotoResult(ann, input(ann), db);
    await savePhotoResult(ann, input(ann), db);
    await savePhotoResult(bob, input(bob), db);
    await db.delete(users).where(eq(users.id, ann));
    expect(await rowCounts()).toEqual([1, 1, 1, 5]);
  });
});

describe("constraints", () => {
  async function seed() {
    const userId = await newUser("a@example.com");
    const { id } = await savePhotoResult(userId, input(userId), db);
    const [playlist] = await db.select().from(playlists);
    return { userId, id, playlistId: playlist.id };
  }
  const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ cause: { code } });

  it("keeps storage_key and (user_id, save_id) unique", async () => {
    const { userId, id } = await seed();
    const [photo] = await db.select().from(photos).where(eq(photos.id, id));
    await rejects(db.insert(photos).values({ userId, saveId: randomUUID(), storageKey: photo.storageKey }), "23505");
    await rejects(db.insert(photos).values({ userId, saveId: photo.saveId, storageKey: "k" }), "23505");
  });

  it("allows one analysis per photo and checks emotion and confidence", async () => {
    const { id } = await seed();
    const row = { photoId: id, primaryEmotion: "calm", secondaryMoods: [], explanation: "e", confidence: 0.5, palette: {}, preferences: {} };
    await rejects(db.insert(analyses).values(row), "23505");
    await db.delete(analyses);
    await rejects(db.insert(analyses).values({ ...row, primaryEmotion: "angry" }), "23514");
    await rejects(db.insert(analyses).values({ ...row, confidence: 1.5 }), "23514");
    await rejects(db.insert(analyses).values({ ...row, confidence: -0.5 }), "23514");
    await db.insert(analyses).values({ ...row, confidence: 1 });
  });

  it("checks the playlist length and the track keys", async () => {
    const { id, playlistId } = await seed();
    await rejects(db.insert(playlists).values({ photoId: id, requestedLength: 7, featuredSpotifyId: "x" }), "23514");
    const [track] = await db.select().from(playlistTracks).where(eq(playlistTracks.position, 0));
    await rejects(db.insert(playlistTracks).values({ ...track, spotifyId: "OtherId" }), "23505");
    await rejects(db.insert(playlistTracks).values({ ...track, position: 99 }), "23505");
    await rejects(db.insert(playlistTracks).values({ ...track, position: 99, spotifyId: "Other", youtubeKind: "x" }), "23514");
    expect(playlistId).toBeTruthy();
  });
});

describe("the migration", () => {
  it("coexists with the users and sessions tables", async () => {
    const userId = await newUser("a@example.com");
    await db.insert(sessions).values({ id: "s", userId, expiresAt: new Date(Date.now() + 1000) });
    await savePhotoResult(userId, input(userId), db);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });
});
