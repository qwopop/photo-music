import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { Database } from "../db";
import { connectionSettings } from "../db/connection";
import * as schema from "../db/schema";
import type { Track } from "../playlist";
import { createPostgresYouTubeCacheStore } from "./cache-store";
import { createYouTubeResolver, NO_RESULT_CACHE_TTL_MS, VIDEO_CACHE_TTL_MS } from "./index";

const pool = new Pool(connectionSettings({ url: inject("testDatabaseUrl") }));
const db = drizzle({ client: pool, schema }) as Database;
const store = () => createPostgresYouTubeCacheStore(() => db);
const key = { title: "song", firstArtist: "artist" };
const video = { kind: "video" as const, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" };
const track: Track = {
  spotifyId: "a".repeat(22), spotifyUrl: `https://open.spotify.com/track/${"a".repeat(22)}`,
  title: "Song", artists: ["Artist", "Other"], album: null, durationMs: 1000, coverImageUrl: null,
};
beforeEach(async () => { await db.delete(schema.youtubeLinkCache); });
afterAll(async () => { await pool.end(); });

describe("PostgreSQL YouTube cache", () => {
  it("returns null on miss and persists kind, URL and fetchedAt across independent stores", async () => {
    expect(await store().get(key)).toBeNull();
    await store().set(key, { link: video, fetchedAt: 123456 });
    expect(await store().get(key)).toEqual({ link: video, fetchedAt: 123456 });
    expect(await store().get({ ...key, firstArtist: "other" })).toBeNull();
  });

  it("upserts the composite key and preserves other titles/artists", async () => {
    await store().set(key, { link: video, fetchedAt: 1000 });
    await store().set({ ...key, firstArtist: "other" }, { link: video, fetchedAt: 2000 });
    const search = { kind: "search" as const, url: "https://www.youtube.com/results?search_query=Song+Artist" };
    await store().set(key, { link: search, fetchedAt: 3000 });
    expect(await store().get(key)).toEqual({ link: search, fetchedAt: 3000 });
    expect(await db.select().from(schema.youtubeLinkCache)).toHaveLength(2);
  });

  it.each([[true, VIDEO_CACHE_TTL_MS], [false, NO_RESULT_CACHE_TTL_MS]])(
    "shares provider results across resolver instances and expires found=%s on time", async (found, ttl) => {
      let clock = 1000;
      const fetch = vi.fn(async () => new Response(JSON.stringify({ items: found ? [
        { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Song", channelTitle: "Artist" } },
      ] : [] })));
      const resolver = () => createYouTubeResolver({ apiKey: "test", fetch, now: () => clock, cacheStore: store() });
      const first = await resolver().resolve(track);
      clock += ttl - 1;
      expect(await resolver().resolve({ ...track, title: " song  ", artists: [" ARTIST "] })).toEqual(first);
      expect(fetch).toHaveBeenCalledTimes(1);
      clock++;
      await resolver().resolve(track);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((await store().get(key))?.fetchedAt).toBe(clock);
    },
  );

  it("treats malformed stored URLs as a miss", async () => {
    await db.insert(schema.youtubeLinkCache).values({ ...key, kind: "video", url: "https://evil.example", fetchedAt: new Date() });
    expect(await store().get(key)).toBeNull();
  });

  it("keeps successful answers in memory when PostgreSQL fails", async () => {
    const unavailable = new Pool({ ...connectionSettings({ url: inject("testDatabaseUrl") }), port: 1, connectionTimeoutMillis: 500 });
    try {
      const broken = drizzle({ client: unavailable, schema }) as Database;
      const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [
        { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Song", channelTitle: "Artist" } },
      ] })));
      const resolver = createYouTubeResolver({ apiKey: "test", fetch, cacheStore: createPostgresYouTubeCacheStore(() => broken) });
      expect(await resolver.resolve(track)).toEqual(video);
      expect(await resolver.resolve(track)).toEqual(video);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await unavailable.end(); }
  });
});
