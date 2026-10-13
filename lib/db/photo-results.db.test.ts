import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { connectionSettings } from "./connection";
import { deletePhotoResult, getPhotoResult, listPhotoResults, PhotoResultError, savePhotoResult } from "./photo-results";
import * as schema from "./schema";
import { users } from "./schema";

const testUrl = inject("testDatabaseUrl");
const pool = new Pool(connectionSettings({ url: testUrl }));
const db = drizzle({ client: pool, schema });

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("delete from users");
});

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: "test-hash" }).returning({ id: users.id });
  return user;
}

function input(userId: string, saveId = "828b4289-877e-46a8-9cfb-488c8d1c226b") {
  return {
    saveId,
    storageKey: `users/${userId}/${saveId}.jpg`,
    mood: MOOD_EXAMPLES[0],
    moodCorrected: false,
    palette: {
      colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"],
      brightness: 0.5,
    },
    preferences: PLAYLIST_EXAMPLES[0].preferences,
    playlist: PLAYLIST_EXAMPLES[0],
  };
}

describe("saved photo results", () => {
  it("saves atomically and restores the validated mood, preferences, palette, and ordered playlist", async () => {
    const user = await makeUser("owner@example.com");
    const saved = await savePhotoResult(user.id, input(user.id), db);
    expect(saved.created).toBe(true);

    const result = await getPhotoResult(user.id, saved.id, db);
    expect(result).toMatchObject({
      id: saved.id,
      storageKey: input(user.id).storageKey,
      mood: input(user.id).mood,
      moodCorrected: false,
      palette: input(user.id).palette,
      preferences: input(user.id).preferences,
      playlist: input(user.id).playlist,
    });
    expect(result?.createdAt).toBeInstanceOf(Date);
    expect(await getPhotoResult("c0c9a8bc-a67d-4f05-9d34-a458730ad2ae", saved.id, db)).toBeNull();
    expect(await getPhotoResult(user.id, "c0c9a8bc-a67d-4f05-9d34-a458730ad2ae", db)).toBeNull();
  });

  it("is idempotent for one user and save id, while another user can use the same save id", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const first = await savePhotoResult(owner.id, input(owner.id), db);
    const retry = await savePhotoResult(owner.id, input(owner.id), db);
    const otherSave = await savePhotoResult(other.id, input(other.id), db);

    expect(first).toEqual({ id: first.id, created: true });
    expect(retry).toEqual({ id: first.id, created: false });
    expect(otherSave.created).toBe(true);
    expect(otherSave.id).not.toBe(first.id);
    expect(await pool.query("select count(*)::int as count from photos")).toMatchObject({ rows: [{ count: 2 }] });
  });

  it("enforces emotion, confidence, playlist length, and track uniqueness in PostgreSQL", async () => {
    const user = await makeUser("owner@example.com");
    const saved = await savePhotoResult(user.id, input(user.id), db);
    const playlistResult = await pool.query<{ id: string }>("select id from playlists where photo_id = $1", [saved.id]);

    await expect(pool.query("update analyses set primary_emotion = 'unknown' where photo_id = $1", [saved.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("update analyses set confidence = 1.1 where photo_id = $1", [saved.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("update playlists set requested_length = 7 where id = $1", [playlistResult.rows[0].id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("insert into playlist_tracks select * from playlist_tracks limit 1"))
      .rejects.toMatchObject({ code: "23505" });
  });

  it("pages newest-first without repeating or skipping equal-timestamp rows", async () => {
    const user = await makeUser("owner@example.com");
    const first = await savePhotoResult(user.id, input(user.id, "828b4289-877e-46a8-9cfb-488c8d1c226b"), db);
    const second = await savePhotoResult(user.id, input(user.id, "6d68c979-5e88-4d8b-87b2-d18c45e5e75d"), db);
    await pool.query("update photos set created_at = '2025-01-01 00:00:00.123456+00' where id = any($1::uuid[])", [
      [first.id, second.id],
    ]);

    const page1 = await listPhotoResults(user.id, { limit: 1 }, db);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listPhotoResults(user.id, { limit: 1, cursor: page1.nextCursor! }, db);
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((item) => item.id))).toEqual(new Set([first.id, second.id]));
  });

  it("rejects an invalid cursor and out-of-range limits", async () => {
    const user = await makeUser("owner@example.com");
    await expect(listPhotoResults(user.id, { limit: 0 }, db)).rejects.toBeInstanceOf(PhotoResultError);
    await expect(listPhotoResults(user.id, { limit: 101 }, db)).rejects.toBeInstanceOf(PhotoResultError);
    await expect(listPhotoResults(user.id, { cursor: "not-a-cursor" }, db)).rejects.toBeInstanceOf(PhotoResultError);
  });

  it("rolls back the photo and analysis when inserting tracks fails", async () => {
    const user = await makeUser("owner@example.com");
    await pool.query(`
      create function fail_saved_track_insert() returns trigger language plpgsql as $$
      begin
        raise exception 'forced test failure';
      end
      $$;
      create trigger fail_saved_track_insert before insert on playlist_tracks
      for each row execute function fail_saved_track_insert();
    `);

    try {
      await expect(savePhotoResult(user.id, input(user.id), db)).rejects.toBeInstanceOf(PhotoResultError);
      for (const table of ["photos", "analyses", "playlists", "playlist_tracks"]) {
        const { rows } = await pool.query(`select count(*)::int as count from ${table}`);
        expect(rows[0].count).toBe(0);
      }
    } finally {
      await pool.query("drop trigger fail_saved_track_insert on playlist_tracks");
      await pool.query("drop function fail_saved_track_insert()");
    }
  });

  it("deletes only the owner result and cascades to its dependent rows", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const target = await savePhotoResult(owner.id, input(owner.id), db);
    const retained = await savePhotoResult(other.id, input(other.id), db);

    expect(await deletePhotoResult(other.id, target.id, db)).toBeNull();
    expect(await deletePhotoResult(owner.id, target.id, db)).toBe(input(owner.id).storageKey);
    expect(await deletePhotoResult(owner.id, target.id, db)).toBeNull();
    expect(await getPhotoResult(other.id, retained.id, db)).not.toBeNull();
    expect(await pool.query("select count(*)::int as count from analyses")).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query("select count(*)::int as count from playlists")).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query("select count(*)::int as count from playlist_tracks")).toMatchObject({ rows: [{ count: 3 }] });
  });

  it("cascades user deletion to saved results without affecting another owner", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    await savePhotoResult(owner.id, input(owner.id), db);
    const retained = await savePhotoResult(other.id, input(other.id), db);

    await db.delete(users).where(eq(users.id, owner.id));
    expect(await pool.query("select count(*)::int as count from photos")).toMatchObject({ rows: [{ count: 1 }] });
    expect(await getPhotoResult(other.id, retained.id, db)).not.toBeNull();
  });
});
