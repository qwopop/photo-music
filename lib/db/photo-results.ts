/**
 * Repository for a signed-in user's saved results: photo reference, mood
 * analysis, palette, preferences and playlist (#25). Server-only.
 *
 * Every function takes `userId` first and scopes by it in SQL. Callers (#26,
 * #27) get the user themselves. The database holds only the storage key, never
 * a photo URL. Like `getDb()`, call these only while handling a request. The
 * last argument is the database, for tests; it defaults to `getDb()`.
 *
 * Errors are `PhotoResultError`s with a fixed message: the Drizzle or `pg`
 * error, which can hold query parameters, is never logged, returned or
 * attached as `cause`.
 */
import "server-only";

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { moodResultSchema, type MoodResult } from "../mood";
import type { PaletteResult } from "../palette";
import { playlistSchema, type Playlist } from "../playlist";
import { preferencesSchema, type Preferences } from "../preferences";
import { getDb, type Database } from "./index";
import { analyses, photos, playlists, playlistTracks } from "./schema";

const MESSAGES = {
  INVALID_INPUT: "The saved result is not valid.",
  INVALID_LIMIT: "The limit must be a whole number from 1 to 100.",
  INVALID_CURSOR: "The cursor is not valid.",
  STORAGE_KEY_TAKEN: "A saved result already uses this storage key.",
  CORRUPT_RESULT: "The stored result does not match its schema.",
  DATABASE_ERROR: "The database could not complete the request.",
} as const;

export type PhotoResultErrorCode = keyof typeof MESSAGES;

export class PhotoResultError extends Error {
  constructor(readonly code: PhotoResultErrorCode) {
    super(MESSAGES[code]);
    this.name = "PhotoResultError";
  }
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

const paletteSchema = z.strictObject({
  colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).min(1).max(12),
  brightness: z.number().min(0).max(1),
});

const saveInputSchema = z.strictObject({
  saveId: z.uuid(),
  storageKey: z.string().min(1).max(1024),
  mood: moodResultSchema,
  moodCorrected: z.boolean(),
  palette: paletteSchema,
  preferences: preferencesSchema,
  playlist: playlistSchema,
});

export interface SavePhotoResultInput {
  saveId: string;
  storageKey: string;
  mood: MoodResult;
  moodCorrected: boolean;
  palette: PaletteResult;
  preferences: Preferences;
  playlist: Playlist;
}

export interface PhotoResult {
  id: string;
  storageKey: string;
  createdAt: Date;
  mood: MoodResult;
  moodCorrected: boolean;
  palette: PaletteResult;
  preferences: Preferences;
  playlist: Playlist;
}

export interface PhotoResultSummary {
  id: string;
  storageKey: string;
  createdAt: Date;
  primaryEmotion: MoodResult["primaryEmotion"];
}

export interface PhotoResultPage {
  items: PhotoResultSummary[];
  nextCursor: string | null;
}

/** PostgreSQL SQLSTATE and constraint name of a failed query, without its message. */
function failureOf(error: unknown): { code?: string; constraint?: string } {
  if (typeof error === "object" && error !== null) {
    const { code, constraint } = error as { code?: unknown; constraint?: unknown };
    return {
      code: typeof code === "string" ? code : undefined,
      constraint: typeof constraint === "string" ? constraint : undefined,
    };
  }
  return {};
}

function toDatabaseError(error: unknown): PhotoResultError {
  if (error instanceof PhotoResultError || (error instanceof Error && error.message.startsWith("DEBUG"))) return error as PhotoResultError;
  const { code, constraint } = failureOf(error);
  if (code === "23505" && constraint === "photos_storage_key_key") return new PhotoResultError("STORAGE_KEY_TAKEN");
  return new PhotoResultError("DATABASE_ERROR");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && z.uuid().safeParse(value).success;
}

/**
 * Saves a photo with its analysis, playlist and tracks in one transaction.
 * Calling it again with the same `userId` and `saveId` (also at the same
 * time) writes nothing and returns the existing id with `created: false`.
 */
export async function savePhotoResult(
  userId: string,
  input: SavePhotoResultInput,
  db: Database = getDb(),
): Promise<{ id: string; created: boolean }> {
  const parsed = saveInputSchema.safeParse(input);
  if (!parsed.success || !isUuid(userId)) throw new PhotoResultError("INVALID_INPUT");
  const { saveId, storageKey, mood, moodCorrected, palette, preferences, playlist } = parsed.data;
  // The playlist repeats the mood; only one copy is stored, so they must agree.
  if (JSON.stringify(playlist.mood) !== JSON.stringify(mood)) throw new PhotoResultError("INVALID_INPUT");

  try {
    return await db.transaction(async (tx) => {
      const [photo] = await tx
        .insert(photos)
        .values({ userId, saveId, storageKey })
        .onConflictDoNothing({ target: [photos.userId, photos.saveId] })
        .returning({ id: photos.id });

      if (!photo) {
        const [existing] = await tx
          .select({ id: photos.id })
          .from(photos)
          .where(and(eq(photos.userId, userId), eq(photos.saveId, saveId)));
        if (!existing) throw new PhotoResultError("DATABASE_ERROR");
        return { id: existing.id, created: false };
      }

      await tx.insert(analyses).values({
        photoId: photo.id,
        primaryEmotion: mood.primaryEmotion,
        secondaryMoods: mood.secondaryMoods,
        explanation: mood.explanation,
        confidence: mood.confidence,
        moodCorrected,
        palette,
        preferences,
      });
      const [list] = await tx
        .insert(playlists)
        .values({
          photoId: photo.id,
          requestedLength: playlist.requestedLength,
          featuredSpotifyId: playlist.featuredTrackId,
        })
        .returning({ id: playlists.id });
      await tx.insert(playlistTracks).values(
        playlist.tracks.map((track, position) => ({
          playlistId: list.id,
          position,
          spotifyId: track.spotifyId,
          spotifyUrl: track.spotifyUrl,
          title: track.title,
          artists: track.artists,
          album: track.album,
          durationMs: track.durationMs,
          coverImageUrl: track.coverImageUrl,
          youtubeKind: track.youtube.kind,
          youtubeUrl: track.youtube.url,
          matchReason: track.matchReason,
        })),
      );
      return { id: photo.id, created: true };
    });
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/** One saved result, or `null` when the id is unknown or belongs to someone else. */
export async function getPhotoResult(
  userId: string,
  id: string,
  db: Database = getDb(),
): Promise<PhotoResult | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  try {
    const [row] = await db
      .select({ photo: photos, analysis: analyses })
      .from(photos)
      .innerJoin(analyses, eq(analyses.photoId, photos.id))
      .where(and(eq(photos.id, id), eq(photos.userId, userId)));
    if (!row) return null;

    const [list] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.photoId, id))
      .orderBy(desc(playlists.createdAt), desc(playlists.id))
      .limit(1);
    if (!list) throw new PhotoResultError("CORRUPT_RESULT");
    const tracks = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, list.id))
      .orderBy(playlistTracks.position);

    const { analysis } = row;
    const mood: MoodResult = {
      primaryEmotion: analysis.primaryEmotion as MoodResult["primaryEmotion"],
      secondaryMoods: analysis.secondaryMoods,
      explanation: analysis.explanation,
      confidence: analysis.confidence,
    };
    const playlist: Playlist = {
      mood,
      requestedLength: list.requestedLength as Playlist["requestedLength"],
      tracks: tracks.map((track) => ({
        spotifyId: track.spotifyId,
        spotifyUrl: track.spotifyUrl,
        title: track.title,
        artists: track.artists,
        album: track.album,
        durationMs: track.durationMs,
        coverImageUrl: track.coverImageUrl,
        youtube: { kind: track.youtubeKind, url: track.youtubeUrl } as Playlist["tracks"][number]["youtube"],
        matchReason: track.matchReason,
      })),
      featuredTrackId: list.featuredSpotifyId,
    };
    const checked = z
      .object({ mood: moodResultSchema, playlist: playlistSchema, preferences: preferencesSchema, palette: paletteSchema })
      .safeParse({ mood, playlist, preferences: analysis.preferences, palette: analysis.palette });
    if (!checked.success) throw new Error("DEBUG " + JSON.stringify(checked.error.issues.map((i) => [i.path, i.message])));

    return {
      id: row.photo.id,
      storageKey: row.photo.storageKey,
      createdAt: row.photo.createdAt,
      mood: checked.data.mood,
      moodCorrected: analysis.moodCorrected,
      palette: checked.data.palette,
      preferences: checked.data.preferences,
      playlist: checked.data.playlist,
    };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

// A cursor holds the created_at of the last item as PostgreSQL printed it
// (with microseconds, which a JS Date would cut off) and its id.
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2) {
      const [createdAt, id] = value as unknown[];
      if (typeof createdAt === "string" && TIMESTAMP_TEXT.test(createdAt) && isUuid(id)) return { createdAt, id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new PhotoResultError("INVALID_CURSOR");
}

/** The user's results, newest first by (created_at, id), `limit` at a time (default 20, at most 100). */
export async function listPhotoResults(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
  db: Database = getDb(),
): Promise<PhotoResultPage> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new PhotoResultError("INVALID_LIMIT");
  const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
  if (!isUuid(userId)) return { items: [], nextCursor: null };

  const createdAtText = sql<string>`${photos.createdAt}::text`;
  try {
    const rows = await db
      .select({
        id: photos.id,
        storageKey: photos.storageKey,
        createdAt: photos.createdAt,
        createdAtText,
        primaryEmotion: analyses.primaryEmotion,
      })
      .from(photos)
      .innerJoin(analyses, eq(analyses.photoId, photos.id))
      .where(
        and(
          eq(photos.userId, userId),
          after
            ? or(
                lt(photos.createdAt, sql`${after.createdAt}::timestamptz`),
                and(eq(photos.createdAt, sql`${after.createdAt}::timestamptz`), lt(photos.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(photos.createdAt), desc(photos.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ id, storageKey, createdAt, primaryEmotion }) => ({
        id,
        storageKey,
        createdAt,
        primaryEmotion: primaryEmotion as PhotoResultSummary["primaryEmotion"],
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtText, last.id) : null,
    };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/**
 * Deletes a result and, by cascade, its analysis, playlists and tracks.
 * Returns the storage key, so the caller can remove the object, or `null`
 * (changing nothing) for an unknown id or another user's.
 */
export async function deletePhotoResult(
  userId: string,
  id: string,
  db: Database = getDb(),
): Promise<string | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  try {
    const [deleted] = await db
      .delete(photos)
      .where(and(eq(photos.id, id), eq(photos.userId, userId)))
      .returning({ storageKey: photos.storageKey });
    return deleted?.storageKey ?? null;
  } catch (error) {
    throw toDatabaseError(error);
  }
}
