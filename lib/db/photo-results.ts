/**
 * Saved results of registered users: a photo (as a storage key), its mood
 * analysis, palette and preferences, and a playlist with its tracks. Server-only.
 *
 * Every function takes the owner's `userId` first and scopes by it in SQL;
 * callers get it from `getCurrentUser()`. The database is an optional last
 * argument so that tests can inject one; by default `getDb()` is called inside
 * the function, while handling a request.
 *
 * Drizzle errors carry the query's parameters in their message, so they are
 * never logged or returned: they become a `PhotoResultError` with fixed text.
 * Only storage keys are stored, never photo URLs.
 */
import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { moodResultSchema, PRIMARY_EMOTIONS, type MoodResult, type PrimaryEmotion } from "../mood";
import type { PaletteResult } from "../palette";
import { playlistSchema, type Playlist } from "../playlist";
import { preferencesSchema, type Preferences } from "../preferences";
import { getDb, type Database } from "./index";
import { analyses, photos, playlists, playlistTracks } from "./schema";

export type PhotoResultErrorCode = "INVALID_INPUT" | "INVALID_LIMIT" | "INVALID_CURSOR" | "DATABASE_ERROR";

const messages: Record<PhotoResultErrorCode, string> = {
  INVALID_INPUT: "The photo result is not valid.",
  INVALID_LIMIT: "The limit must be a whole number from 1 to 100.",
  INVALID_CURSOR: "The list cursor is not valid.",
  DATABASE_ERROR: "The photo results could not be read or written.",
};

/** Safe to log or show: fixed text, no cause, no query parameters. */
export class PhotoResultError extends Error {
  constructor(readonly code: PhotoResultErrorCode) {
    super(messages[code]);
    this.name = "PhotoResultError";
  }
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

const uuidSchema = z.uuid();
const paletteSchema = z.strictObject({
  colors: z.array(z.string().min(1).max(32)).max(32),
  brightness: z.number().min(0).max(1),
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

/** Checks the input with the shared schemas, before anything is written. Needs no database. */
export function validateSavePhotoResultInput(userId: string, input: SavePhotoResultInput): SavePhotoResultInput {
  try {
    uuidSchema.parse(userId);
    return {
      saveId: uuidSchema.parse(input.saveId),
      storageKey: z.string().min(1).max(1024).regex(/\S/).parse(input.storageKey),
      mood: moodResultSchema.parse(input.mood),
      moodCorrected: z.boolean().parse(input.moodCorrected),
      palette: paletteSchema.parse(input.palette),
      preferences: preferencesSchema.parse(input.preferences),
      playlist: playlistSchema.parse(input.playlist),
    };
  } catch {
    throw new PhotoResultError("INVALID_INPUT");
  }
}

function fail(error: unknown): never {
  if (error instanceof PhotoResultError) throw error;
  console.error("A photo result database operation failed; check the database configuration and connection.");
  throw new PhotoResultError("DATABASE_ERROR");
}

/**
 * Writes the photo, analysis, playlist and all tracks in one transaction.
 * The same (userId, saveId) again creates nothing and returns the existing id
 * with `created: false`.
 */
export async function savePhotoResult(
  userId: string,
  input: SavePhotoResultInput,
  injected?: Database,
): Promise<{ id: string; created: boolean }> {
  const valid = validateSavePhotoResultInput(userId, input);
  try {
    const db = injected ?? getDb();
    return await db.transaction(async (tx) => {
      const [photo] = await tx
        .insert(photos)
        .values({ userId, saveId: valid.saveId, storageKey: valid.storageKey })
        .onConflictDoNothing({ target: [photos.userId, photos.saveId] })
        .returning({ id: photos.id });
      if (!photo) {
        const [existing] = await tx
          .select({ id: photos.id })
          .from(photos)
          .where(and(eq(photos.userId, userId), eq(photos.saveId, valid.saveId)));
        if (!existing) throw new Error("conflicting photo vanished");
        return { id: existing.id, created: false };
      }
      await tx.insert(analyses).values({
        photoId: photo.id,
        primaryEmotion: valid.mood.primaryEmotion,
        secondaryMoods: valid.mood.secondaryMoods,
        explanation: valid.mood.explanation,
        confidence: valid.mood.confidence,
        moodCorrected: valid.moodCorrected,
        palette: valid.palette,
        preferences: valid.preferences,
      });
      const [playlist] = await tx
        .insert(playlists)
        .values({
          photoId: photo.id,
          requestedLength: valid.playlist.requestedLength,
          featuredSpotifyId: valid.playlist.featuredTrackId,
        })
        .returning({ id: playlists.id });
      await tx.insert(playlistTracks).values(
        valid.playlist.tracks.map((track, position) => ({
          playlistId: playlist.id,
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
    return fail(error);
  }
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

/** The saved result, or null for an unknown id and for another user's id alike. */
export async function getPhotoResult(userId: string, id: string, injected?: Database): Promise<PhotoResult | null> {
  if (!uuidSchema.safeParse(id).success) return null;
  try {
    const db = injected ?? getDb();
    const [row] = await db
      .select({
        id: photos.id,
        storageKey: photos.storageKey,
        createdAt: photos.createdAt,
        primaryEmotion: analyses.primaryEmotion,
        secondaryMoods: analyses.secondaryMoods,
        explanation: analyses.explanation,
        confidence: analyses.confidence,
        moodCorrected: analyses.moodCorrected,
        palette: analyses.palette,
        preferences: analyses.preferences,
      })
      .from(photos)
      .innerJoin(analyses, eq(analyses.photoId, photos.id))
      .where(and(eq(photos.userId, userId), eq(photos.id, id)));
    if (!row) return null;
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.photoId, row.id))
      .orderBy(desc(playlists.createdAt), desc(playlists.id))
      .limit(1);
    if (!playlist) return null;
    const tracks = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlist.id))
      .orderBy(asc(playlistTracks.position));

    const mood = moodResultSchema.parse({
      primaryEmotion: row.primaryEmotion,
      secondaryMoods: row.secondaryMoods,
      explanation: row.explanation,
      confidence: row.confidence,
    });
    return {
      id: row.id,
      storageKey: row.storageKey,
      createdAt: row.createdAt,
      mood,
      moodCorrected: row.moodCorrected,
      palette: paletteSchema.parse(row.palette),
      preferences: preferencesSchema.parse(row.preferences),
      playlist: playlistSchema.parse({
        mood,
        requestedLength: playlist.requestedLength,
        tracks: tracks.map((t) => ({
          spotifyId: t.spotifyId,
          spotifyUrl: t.spotifyUrl,
          title: t.title,
          artists: t.artists,
          album: t.album,
          durationMs: t.durationMs,
          coverImageUrl: t.coverImageUrl,
          youtube: { kind: t.youtubeKind, url: t.youtubeUrl },
          matchReason: t.matchReason,
        })),
        featuredTrackId: playlist.featuredSpotifyId,
      }),
    };
  } catch (error) {
    return fail(error);
  }
}

export interface PhotoResultSummary {
  id: string;
  storageKey: string;
  createdAt: Date;
  primaryEmotion: PrimaryEmotion;
}

export interface PhotoResultPage {
  items: PhotoResultSummary[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

// created_at has microseconds, which a JS Date drops, so the cursor keeps the
// exact timestamp as text.
const cursorSchema = z.strictObject({ t: z.string().min(1).max(64), id: uuidSchema });

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new PhotoResultError("INVALID_CURSOR");
  }
}

/** The user's results, newest first by (created_at, id) descending. */
export async function listPhotoResults(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
  injected?: Database,
): Promise<PhotoResultPage> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new PhotoResultError("INVALID_LIMIT");
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  try {
    const db = injected ?? getDb();
    const exact = sql<string>`${photos.createdAt}::text`;
    const rows = await db
      .select({
        id: photos.id,
        storageKey: photos.storageKey,
        createdAt: photos.createdAt,
        exact,
        primaryEmotion: analyses.primaryEmotion,
      })
      .from(photos)
      .innerJoin(analyses, eq(analyses.photoId, photos.id))
      .where(
        and(
          eq(photos.userId, userId),
          after ? sql`(${photos.createdAt}, ${photos.id}) < (${after.t}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(photos.createdAt), desc(photos.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        storageKey: row.storageKey,
        createdAt: row.createdAt,
        primaryEmotion: z.enum(PRIMARY_EMOTIONS).parse(row.primaryEmotion),
      })),
      nextCursor:
        rows.length > limit && last ? Buffer.from(JSON.stringify({ t: last.exact, id: last.id })).toString("base64url") : null,
    };
  } catch (error) {
    return fail(error);
  }
}

/** Deletes an owned result (cascading) and returns its storage key; null and no change otherwise. */
export async function deletePhotoResult(userId: string, id: string, injected?: Database): Promise<string | null> {
  if (!uuidSchema.safeParse(id).success) return null;
  try {
    const db = injected ?? getDb();
    const [deleted] = await db
      .delete(photos)
      .where(and(eq(photos.userId, userId), eq(photos.id, id)))
      .returning({ storageKey: photos.storageKey });
    return deleted?.storageKey ?? null;
  } catch (error) {
    return fail(error);
  }
}
