import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, DatabaseError, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../../scripts/migrate-database";
import { MOOD_EXAMPLES, moodResultSchema } from "../mood";
import { PLAYLIST_EXAMPLES, playlistSchema } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import { connectionSettings } from "./connection";
import type { Database } from "./index";
import {
  deletePhotoResult,
  getPhotoResult,
  listPhotoResults,
  PhotoResultError,
  savePhotoResult,
  type SavePhotoResultInput,
} from "./photo-results";
import * as schema from "./schema";

// Runs with `npm run test:db` (and in the CI `database` job), against this
// run's throwaway database, migrated with the committed migrations.

const testUrl = inject("testDatabaseUrl");
let client: Client;
let pool: Pool;
let db: Database;

beforeAll(async () => {
  client = new Client(connectionSettings({ url: testUrl }));
  await client.connect();
  pool = new Pool(connectionSettings({ url: testUrl }));
  db = drizzle({ client: pool, schema }) as Database;
});

afterAll(async () => {
  await pool.end();
  await client.end();
});

let userA: string;
let userB: string;

beforeEach(async () => {
  await client.query("delete from users");
  userA = await insertUser("a@example.com");
  userB = await insertUser("b@example.com");
});

async function insertUser(email: string): Promise<string> {
  const { rows } = await client.query("insert into users (email, password_hash) values ($1, 'h') returning id", [email]);
  return rows[0].id as string;
}

async function rows<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query(text, values)).rows as T[];
}

async function failure(text: string, values: unknown[] = []): Promise<DatabaseError> {
  try {
    await client.query(text, values);
  } catch (error) {
    if (error instanceof DatabaseError) return error;
    throw error;
  }
  throw new Error(`Expected the query to fail: ${text}`);
}

async function count(table: string): Promise<number> {
  return Number((await rows<{ n: string }>(`select count(*) as n from ${table}`))[0].n);
}

const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

function input(n = 1, playlistIndex = 0): SavePhotoResultInput {
  const playlist = structuredClone(PLAYLIST_EXAMPLES[playlistIndex]);
  return {
    saveId: uuid(n),
    storageKey: `users/test/${uuid(n)}.jpg`,
    mood: structuredClone(playlist.mood),
    moodCorrected: false,
    palette: { colors: ["#112233", "#445566", "#778899"], brightness: 0.25 },
    preferences: { ...DEFAULT_PREFERENCES, genres: ["jazz", "lo-fi"], artists: ["Nina"], situation: "studying", length: 5 },
    playlist,
  };
}

const FIRST_TRACKS = PLAYLIST_EXAMPLES[0].tracks.length;

async function counts() {
  return [await count("photos"), await count("analyses"), await count("playlists"), await count("playlist_tracks")];
}

describe("the saved-results tables", () => {
  it("have the expected indexes", async () => {
    const indexes = await rows<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('photos', 'playlists')",
    );
    const byName = Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]));
    expect(byName.photos_user_id_created_at_id_idx).toContain("(user_id, created_at DESC, id DESC)");
    expect(byName.playlists_photo_id_idx).toContain("(photo_id)");
  });

  it("refuse a second analysis for a photo, an unknown emotion, a confidence outside 0 to 1, and more than 3 moods", async () => {
    const { id } = await savePhotoResult(userA, input(), db);
    const insert = (emotion: string, moods: string, confidence: number, photo: string) =>
      failure(
        `insert into analyses (photo_id, primary_emotion, secondary_moods, explanation, confidence, palette, preferences)
         values ($1, $2, $3::jsonb, 'x', $4, '{}', '{}')`,
        [photo, emotion, moods, confidence],
      );
    expect((await insert("calm", "[]", 0.5, id)).constraint).toBe("analyses_photo_id_key");

    const other = (await savePhotoResult(userA, input(2), db)).id;
    await client.query("delete from analyses where photo_id = $1", [other]);
    expect((await insert("angry", "[]", 0.5, other)).constraint).toBe("analyses_primary_emotion_check");
    expect((await insert("calm", "[]", 1.5, other)).constraint).toBe("analyses_confidence_check");
    expect((await insert("calm", "[]", -0.5, other)).constraint).toBe("analyses_confidence_check");
    expect((await insert("calm", '["a","b","c","d"]', 0.5, other)).constraint).toBe("analyses_secondary_moods_check");
  });

  it("refuse a playlist length other than 5, 10, 20 and 30", async () => {
    const { id } = await savePhotoResult(userA, input(), db);
    const error = await failure("insert into playlists (photo_id, requested_length, featured_spotify_id) values ($1, 7, 'x')", [id]);
    expect(error.constraint).toBe("playlists_requested_length_check");
  });

  it("refuse a duplicate position or Spotify id in one playlist", async () => {
    const { id } = await savePhotoResult(userA, input(), db);
    const [{ id: playlistId }] = await rows<{ id: string }>("select id from playlists where photo_id = $1", [id]);
    const insert = (position: number, spotifyId: string) =>
      failure(
        `insert into playlist_tracks (playlist_id, position, spotify_id, spotify_url, title, artists, duration_ms, youtube_kind, youtube_url, match_reason)
         values ($1, $2, $3, 'u', 't', '[]', 1, 'video', 'y', 'm')`,
        [playlistId, position, spotifyId],
      );
    expect((await insert(0, "NewId")).constraint).toBe("playlist_tracks_playlist_id_position_key");
    expect((await insert(99, PLAYLIST_EXAMPLES[0].tracks[0].spotifyId)).constraint).toBe(
      "playlist_tracks_playlist_id_spotify_id_key",
    );
  });

  it("allow the same Spotify id in two playlists", async () => {
    await savePhotoResult(userA, input(1), db);
    expect((await savePhotoResult(userA, input(2), db)).created).toBe(true);
  });

  it("refuse a second photo with the same user and save id, or the same storage key", async () => {
    await savePhotoResult(userA, input(), db);
    const dupSave = await failure("insert into photos (user_id, storage_key, save_id) values ($1, 'other', $2)", [userA, uuid(1)]);
    expect(dupSave.constraint).toBe("photos_user_id_save_id_key");
    const dupKey = await failure("insert into photos (user_id, storage_key, save_id) values ($1, $2, $3)", [userB, input().storageKey, uuid(9)]);
    expect(dupKey.constraint).toBe("photos_storage_key_key");
  });

  it("refuse a photo for a user that does not exist", async () => {
    const error = await failure("insert into photos (user_id, storage_key, save_id) values ($1, 'k', $2)", [uuid(77), uuid(78)]);
    expect(error.code).toBe("23503");
  });
});

describe("the create_saved_results migration", () => {
  it("applies on a database that already has users and sessions, and keeps their rows", async () => {
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    await client.query("begin");
    try {
      await client.query("create schema before_saved_results");
      await client.query("set local search_path to before_saved_results");
      for (const migration of migrations.slice(0, 2)) for (const s of migration.sql) if (s.trim()) await client.query(s);
      await client.query("insert into users (id, email, password_hash) values ($1, 'old@example.com', 'h')", [uuid(500)]);
      await client.query("insert into sessions (id, user_id, expires_at) values ('s', $1, now())", [uuid(500)]);
      for (const s of migrations[2].sql) if (s.trim()) await client.query(s);
      expect(await rows("select email from users")).toEqual([{ email: "old@example.com" }]);
      expect(await rows("select id from sessions")).toEqual([{ id: "s" }]);
      expect(await rows("select count(*)::int as n from photos")).toEqual([{ n: 0 }]);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("savePhotoResult and getPhotoResult", () => {
  it.each(PLAYLIST_EXAMPLES.map((_, index) => index))("round-trips PLAYLIST_EXAMPLES[%i] with its track order", async (index) => {
    const saved = input(index + 1, index);
    saved.moodCorrected = index % 2 === 1;
    const { id, created } = await savePhotoResult(userA, saved, db);
    expect(created).toBe(true);

    const result = await getPhotoResult(userA, id, db);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.storageKey).toBe(saved.storageKey);
    expect(result!.createdAt).toBeInstanceOf(Date);
    expect(result!.mood).toEqual(saved.mood);
    expect(result!.moodCorrected).toBe(saved.moodCorrected);
    expect(result!.palette).toEqual(saved.palette);
    expect(result!.preferences).toEqual(saved.preferences);
    expect(result!.playlist).toEqual(saved.playlist);
    expect(moodResultSchema.safeParse(result!.mood).success).toBe(true);
    expect(playlistSchema.safeParse(result!.playlist).success).toBe(true);
  });

  it("round-trips every MOOD_EXAMPLES entry, including confidence 0 and 1", async () => {
    for (const [index, mood] of MOOD_EXAMPLES.entries()) {
      const saved = input(index + 1);
      saved.mood = structuredClone(mood);
      saved.playlist.mood = structuredClone(mood);
      const { id } = await savePhotoResult(userA, saved, db);
      expect((await getPhotoResult(userA, id, db))!.mood).toEqual(mood);
    }
  });

  it("returns null for an unknown id and for another user's id, the same way", async () => {
    const { id } = await savePhotoResult(userA, input(), db);
    expect(await getPhotoResult(userB, id, db)).toBeNull();
    expect(await getPhotoResult(userA, uuid(404), db)).toBeNull();
    expect(await getPhotoResult(userA, "not-a-uuid", db)).toBeNull();
  });

  it("writes nothing when the last insert fails", async () => {
    const bad = input();
    // PostgreSQL text cannot hold a NUL character, so the track insert fails
    // after the photo, analysis and playlist were inserted.
    bad.playlist.tracks[bad.playlist.tracks.length - 1].title = "bad\u0000title";
    const error = await savePhotoResult(userA, bad, db).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoResultError);
    expect((error as PhotoResultError).code).toBe("DATABASE_ERROR");
    expect((error as PhotoResultError).message).not.toMatch(/title|insert/i);
    expect((error as PhotoResultError).cause).toBeUndefined();
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });

  it("is idempotent for the same user and saveId", async () => {
    const first = await savePhotoResult(userA, input(), db);
    const again = await savePhotoResult(userA, input(), db);
    expect(again).toEqual({ id: first.id, created: false });
    expect(await counts()).toEqual([1, 1, 1, FIRST_TRACKS]);
  });

  it("is idempotent for concurrent calls", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => savePhotoResult(userA, input(), db)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await counts()).toEqual([1, 1, 1, FIRST_TRACKS]);
  });

  it("creates a separate result for the same saveId and another user", async () => {
    const a = await savePhotoResult(userA, input(), db);
    const other = input();
    other.storageKey = "users/other/key.jpg";
    const b = await savePhotoResult(userB, other, db);
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it("reports a storage key used by another save as STORAGE_KEY_TAKEN and writes nothing more", async () => {
    await savePhotoResult(userA, input(), db);
    const clash = input(2);
    clash.storageKey = input(1).storageKey;
    const error = await savePhotoResult(userA, clash, db).catch((e: unknown) => e);
    expect((error as PhotoResultError).code).toBe("STORAGE_KEY_TAKEN");
    expect(await count("photos")).toBe(1);
  });

  it("rejects invalid input without writing", async () => {
    const bad = input();
    bad.playlist.featuredTrackId = "NotInTheTracks0000000000";
    await expect(savePhotoResult(userA, bad, db)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });
});

describe("listPhotoResults", () => {
  async function seed(total: number) {
    for (let n = 1; n <= total; n++) await savePhotoResult(userA, input(n), db);
  }

  it("returns only the user's items, newest first, with the summary fields", async () => {
    await seed(3);
    await savePhotoResult(userB, { ...input(1), storageKey: "users/b/1.jpg" }, db);
    const page = await listPhotoResults(userA, {}, db);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toEqual({
      id: expect.any(String),
      storageKey: expect.any(String),
      createdAt: expect.any(Date),
      primaryEmotion: "happy",
    });
    const times = page.items.map((item) => item.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("pages without repeating or skipping, including identical created_at", async () => {
    await seed(7);
    // Groups of items share one timestamp, to the microsecond.
    await client.query(`update photos set created_at = case
      when right(save_id::text, 1) in ('1', '2', '3') then timestamptz '2026-01-01 10:00:00.123456+00'
      when right(save_id::text, 1) in ('4', '5') then timestamptz '2026-01-01 10:00:00.123457+00'
      else timestamptz '2026-01-02 10:00:00+00' end`);
    const expected = await rows<{ id: string }>("select id from photos order by created_at desc, id desc");

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPhotoResults(userA, { limit: 2, cursor }, db);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expected.map((row) => row.id));
  });

  it("returns a null cursor when the items fit exactly", async () => {
    await seed(2);
    expect((await listPhotoResults(userA, { limit: 2 }, db)).nextCursor).toBeNull();
    expect((await listPhotoResults(userA, { limit: 1 }, db)).nextCursor).not.toBeNull();
  });

  it("uses 20 as the default limit and rejects limits outside 1 to 100", async () => {
    await seed(21);
    const page = await listPhotoResults(userA, {}, db);
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    await expect(listPhotoResults(userA, { limit: 0 }, db)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    await expect(listPhotoResults(userA, { limit: 101 }, db)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    expect((await listPhotoResults(userA, { limit: 100 }, db)).items).toHaveLength(21);
  });

  it("does not leak items through another user's cursor", async () => {
    await seed(3);
    const page = await listPhotoResults(userA, { limit: 1 }, db);
    expect((await listPhotoResults(userB, { cursor: page.nextCursor! }, db)).items).toEqual([]);
  });
});

describe("deleting", () => {
  it("deletePhotoResult removes the photo, analysis, playlists and tracks, and returns the storage key", async () => {
    const saved = input();
    const { id } = await savePhotoResult(userA, saved, db);
    await savePhotoResult(userA, input(2), db);
    expect(await deletePhotoResult(userA, id, db)).toBe(saved.storageKey);
    expect(await counts()).toEqual([1, 1, 1, FIRST_TRACKS]);
    expect(await getPhotoResult(userA, id, db)).toBeNull();
  });

  it("returns null and changes nothing for another user's or an unknown id", async () => {
    const { id } = await savePhotoResult(userA, input(), db);
    expect(await deletePhotoResult(userB, id, db)).toBeNull();
    expect(await deletePhotoResult(userA, uuid(404), db)).toBeNull();
    expect(await deletePhotoResult(userA, "nope", db)).toBeNull();
    expect(await counts()).toEqual([1, 1, 1, FIRST_TRACKS]);
  });

  it("deleting a user removes all their rows and keeps another user's", async () => {
    await savePhotoResult(userA, input(1), db);
    await savePhotoResult(userA, input(2), db);
    await savePhotoResult(userB, { ...input(3), storageKey: "users/b/3.jpg" }, db);
    await client.query("delete from users where id = $1", [userA]);
    expect(await counts()).toEqual([1, 1, 1, FIRST_TRACKS]);
    expect((await listPhotoResults(userB, {}, db)).items).toHaveLength(1);
  });
});
