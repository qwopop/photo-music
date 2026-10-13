import { DrizzleQueryError } from "drizzle-orm/errors";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { closeDb, getDb } from "../db";
import { analyses, photos, playlists, playlistTracks, users } from "../db/schema";
import { MOOD_EXAMPLES } from "../mood";
import { playlistSchema, PLAYLIST_EXAMPLES } from "../playlist";
import { deletePhoto, getPhotoResult, HistoryError, listPhotos, savePhotoResult } from "./index";

const testUrl = inject("testDatabaseUrl");
const palette = { colors: ["#112233", "#445566"], brightness: 0.4 };

beforeAll(() => vi.stubEnv("DATABASE_URL", testUrl));
beforeEach(async () => {
  await getDb().delete(users);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await closeDb();
  vi.unstubAllEnvs();
});

async function newUser(email: string): Promise<string> {
  const [user] = await getDb().insert(users).values({ email, passwordHash: "x" }).returning({ id: users.id });
  return user.id;
}

function input(userId: string, overrides: Partial<Parameters<typeof savePhotoResult>[1]> = {}) {
  return {
    saveId: randomUUID(),
    storageKey: `users/${userId}/${randomUUID()}.jpg`,
    palette,
    mood: MOOD_EXAMPLES[0],
    moodCorrected: false,
    playlist: PLAYLIST_EXAMPLES[0],
    ...overrides,
  };
}

async function counts() {
  const db = getDb();
  return [
    (await db.select().from(photos)).length,
    (await db.select().from(analyses)).length,
    (await db.select().from(playlists)).length,
    (await db.select().from(playlistTracks)).length,
  ];
}

describe("savePhotoResult and getPhotoResult", () => {
  it("round-trips a result", async () => {
    const userId = await newUser("a@example.com");
    const data = input(userId, { moodCorrected: true, playlist: PLAYLIST_EXAMPLES[1], mood: PLAYLIST_EXAMPLES[1].mood });
    const id = await savePhotoResult(userId, data);
    const result = await getPhotoResult(userId, id);
    expect(result).toMatchObject({
      id,
      storageKey: data.storageKey,
      palette,
      mood: data.mood,
      moodCorrected: true,
      playlist: { requestedLength: 10, featuredSpotifyId: data.playlist.featuredTrackId, tracks: data.playlist.tracks },
    });
    expect(result?.playlist?.preferences.length).toBe(10);
    expect(await counts()).toEqual([1, 1, 1, 3]);
  });

  it("returns the latest playlist when there are several", async () => {
    const userId = await newUser("a@example.com");
    const id = await savePhotoResult(userId, input(userId));
    const [analysis] = await getDb().select().from(analyses);
    const [first] = await getDb().select().from(playlists);
    const [second] = await getDb()
      .insert(playlists)
      .values({
        analysisId: analysis.id,
        requestedLength: 5,
        featuredSpotifyId: "ExampleTrackId00000007",
        preferences: first.preferences,
        createdAt: new Date(first.createdAt.getTime() + 1000),
      })
      .returning();
    await getDb().insert(playlistTracks).values({
      playlistId: second.id,
      position: 0,
      spotifyId: "ExampleTrackId00000007",
      track: PLAYLIST_EXAMPLES[2].tracks[0],
    });
    const result = await getPhotoResult(userId, id);
    expect(result?.playlist?.id).toBe(second.id);
    expect(result?.playlist?.tracks).toHaveLength(1);
  });

  it("returns null for another user's, a missing and a malformed photo id alike", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const id = await savePhotoResult(ann, input(ann));
    expect(await getPhotoResult(bob, id)).toBeNull();
    expect(await getPhotoResult(ann, randomUUID())).toBeNull();
    expect(await getPhotoResult(ann, "nope")).toBeNull();
    expect(await getPhotoResult(ann, id)).not.toBeNull();
  });
});

describe("idempotency", () => {
  it("returns the existing photo for the same saveId and adds no rows", async () => {
    const userId = await newUser("a@example.com");
    const data = input(userId);
    const first = await savePhotoResult(userId, data);
    const second = await savePhotoResult(userId, { ...data, storageKey: `users/${userId}/${randomUUID()}.png` });
    expect(second).toBe(first);
    expect(await counts()).toEqual([1, 1, 1, 5]);
  });

  it("handles concurrent saves with one photo", async () => {
    const userId = await newUser("a@example.com");
    const data = input(userId);
    const ids = await Promise.all([savePhotoResult(userId, data), savePhotoResult(userId, data)]);
    expect(ids[0]).toBe(ids[1]);
    expect(await counts()).toEqual([1, 1, 1, 5]);
  });

  it("allows the same saveId for a different user", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const saveId = randomUUID();
    const a = await savePhotoResult(ann, input(ann, { saveId }));
    const b = await savePhotoResult(bob, input(bob, { saveId }));
    expect(a).not.toBe(b);
    expect((await counts())[0]).toBe(2);
  });
});

describe("validation and atomicity", () => {
  it("rejects an invalid mood or playlist before any write", async () => {
    const userId = await newUser("a@example.com");
    const badMood = { ...MOOD_EXAMPLES[0], confidence: 2 };
    await expect(savePhotoResult(userId, input(userId, { mood: badMood }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const badPlaylist = { ...PLAYLIST_EXAMPLES[0], featuredTrackId: "missing" };
    await expect(savePhotoResult(userId, input(userId, { playlist: badPlaylist }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });

  it("leaves no partial rows when the tracks fail to insert", async () => {
    const userId = await newUser("a@example.com");
    const base = PLAYLIST_EXAMPLES[0];
    const duplicated = { ...base, tracks: [base.tracks[0], { ...base.tracks[1], spotifyId: base.tracks[0].spotifyId }] };
    vi.spyOn(playlistSchema, "parse").mockReturnValue(duplicated);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(savePhotoResult(userId, input(userId))).rejects.toMatchObject({ code: "DATABASE_ERROR" });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });

  it("maps a database error to a safe error without logging its message", async () => {
    const ann = await newUser("a@example.com");
    const first = input(ann);
    await savePhotoResult(ann, first);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // Same storage key under a new saveId violates the unique key.
    const error = await savePhotoResult(ann, input(ann, { storageKey: first.storageKey })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HistoryError);
    expect(error).not.toBeInstanceOf(DrizzleQueryError);
    const text = JSON.stringify([(error as Error).message, (error as Error).cause, logged.mock.calls]);
    expect(text).not.toContain(first.storageKey);
    expect(text).not.toMatch(/insert into|photos_storage_key/i);
    expect((error as HistoryError).code).toBe("DATABASE_ERROR");
  });
});

describe("listPhotos", () => {
  it("lists newest first, breaks ties by id and never mixes users", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await savePhotoResult(ann, input(ann, { mood: MOOD_EXAMPLES[i] })));
    const bobId = await savePhotoResult(bob, input(bob));
    const when = new Date("2026-01-01T00:00:00Z");
    await getDb().update(photos).set({ createdAt: when });
    const list = await listPhotos(ann, { limit: 10 });
    expect(list.nextCursor).toBeNull();
    expect(list.photos.map((p) => p.id)).toEqual([...ids].sort().reverse());
    expect(list.photos[0]).toMatchObject({ createdAt: when });
    expect(list.photos.map((p) => p.id)).not.toContain(bobId);
    expect((await listPhotos(bob, { limit: 10 })).photos.map((p) => p.id)).toEqual([bobId]);

    await getDb().update(photos).set({ createdAt: new Date("2026-02-01T00:00:00Z") }).where(sqlId(ids[0]));
    expect((await listPhotos(ann, { limit: 10 })).photos[0].id).toBe(ids[0]);
  });

  it("pages with a cursor, including photos created in the same millisecond", async () => {
    const userId = await newUser("a@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await savePhotoResult(userId, input(userId)));
    await getDb().execute(`update photos set created_at = '2026-01-01 00:00:00.000100+00'`);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPhotos(userId, { limit: 2, cursor });
      seen.push(...page.photos.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("rejects a bad limit and a bad cursor", async () => {
    const userId = await newUser("a@example.com");
    await expect(listPhotos(userId, { limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(listPhotos(userId, { limit: 5, cursor: "garbage" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("deletePhoto and cascades", () => {
  it("deletes only an owned photo, returns its key and cascades", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    const data = input(ann);
    const id = await savePhotoResult(ann, data);
    await savePhotoResult(bob, input(bob));
    expect(await deletePhoto(bob, id)).toBeNull();
    expect((await counts())[0]).toBe(2);
    expect(await deletePhoto(ann, id)).toBe(data.storageKey);
    expect(await counts()).toEqual([1, 1, 1, 5]);
    expect(await deletePhoto(ann, id)).toBeNull();
  });

  it("removes all of a user's rows when the user is deleted", async () => {
    const ann = await newUser("a@example.com");
    const bob = await newUser("b@example.com");
    await savePhotoResult(ann, input(ann));
    await savePhotoResult(ann, input(ann));
    await savePhotoResult(bob, input(bob));
    await getDb().delete(users).where(sqlUser(ann));
    expect(await counts()).toEqual([1, 1, 1, 5]);
  });
});

import { eq } from "drizzle-orm";
function sqlId(id: string) {
  return eq(photos.id, id);
}
function sqlUser(id: string) {
  return eq(users.id, id);
}
