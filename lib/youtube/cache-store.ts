import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../db";
import { youtubeLinkCache } from "../db/schema";
import { youtubeLinkSchema } from "../playlist";
import type { YouTubeCacheStore } from "./index";

/**
 * Inject as `cacheStore` into createYouTubeResolver to share results across
 * server instances. Creation reads no config; methods run during requests.
 * The resolver handles database failures without logging query parameters.
 */
export function createPostgresYouTubeCacheStore(getDatabase: () => Database = getDb): YouTubeCacheStore {
  return {
    async get(key) {
      const [row] = await getDatabase().select().from(youtubeLinkCache).where(and(
        eq(youtubeLinkCache.title, key.title),
        eq(youtubeLinkCache.firstArtist, key.firstArtist),
      )).limit(1);
      if (!row) return null;
      const parsed = youtubeLinkSchema.safeParse({ kind: row.kind, url: row.url });
      if (!parsed.success) return null;
      return { link: parsed.data, fetchedAt: row.fetchedAt.getTime() };
    },
    async set(key, entry) {
      const value = { ...key, ...entry.link, fetchedAt: new Date(entry.fetchedAt) };
      await getDatabase().insert(youtubeLinkCache).values(value).onConflictDoUpdate({
        target: [youtubeLinkCache.title, youtubeLinkCache.firstArtist],
        set: { kind: value.kind, url: value.url, fetchedAt: value.fetchedAt },
      });
    },
  };
}
