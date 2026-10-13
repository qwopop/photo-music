/**
 * Saved photo results: photos (as storage keys), moods and playlists of
 * registered users. Server-only. Every function takes the owner's `userId` and
 * filters on it in SQL. `getDb()` is called only inside the functions.
 *
 * Drizzle errors carry the query's parameters in their message, so they are
 * never logged or returned: they are mapped to a `HistoryError` with fixed text.
 */
import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import { analyses, photos, playlists, playlistTracks } from "../db/schema";
import { moodResultSchema, type MoodResult, type PrimaryEmotion } from "../mood";
import type { PaletteResult } from "../palette";
import { playlistSchema, playlistTrackSchema, type Playlist, type PlaylistLength, type PlaylistTrack } from "../playlist";
import { DEFAULT_PREFERENCES, preferencesSchema, type Preferences } from "../preferences";

export type HistoryErrorCode = "INVALID_INPUT" | "INVALID_CURSOR" | "DATABASE_ERROR";

const messages: Record<HistoryErrorCode, string> = {
  INVALID_INPUT: "The saved result is not valid.",
  INVALID_CURSOR: "The list cursor is not valid.",
  DATABASE_ERROR: "The saved results could not be read or written.",
};

/** Safe to show or log: fixed message, no cause, no query parameters. */
export class HistoryError extends Error {
  constructor(readonly code: HistoryErrorCode) {
    super(messages[code]);
    this.name = "HistoryError";
  }
}

const paletteSchema = z.strictObject({
  colors: z.array(z.string().min(1).max(32)).min(1).max(32),
  brightness: z.number().min(0).max(1),
});
const uuidSchema = z.uuid();

/** Rethrows our own errors; maps anything else to a safe error and logs fixed text. */
function safe(error: unknown): never {
  if (error instanceof HistoryError) throw error;
  console.error("A saved-results database operation failed; check the database configuration and connection.");
  throw new HistoryError("DATABASE_ERROR");
}

export interface SavePhotoResultInput {
  saveId: string;
  storageKey: string;
  palette: PaletteResult;
  mood: MoodResult;
  moodCorrected: boolean;
  playlist: Playlist;
  /** Defaults to the default preferences with the playlist's length. */
  preferences?: Preferences;
}

/**
 * Writes the photo, analysis, playlist and tracks in one transaction. Saving
 * the same (userId, saveId) again returns the existing photo id and writes
 * nothing. Returns the photo id.
 */
export async function savePhotoResult(userId: string, input: SavePhotoResultInput): Promise<string> {
  let valid;
  try {
    valid = {
      userId: uuidSchema.parse(userId),
      saveId: uuidSchema.parse(input.saveId),
      storageKey: z.string().min(1).max(512).parse(input.storageKey),
      palette: paletteSchema.parse(input.palette),
      mood: moodResultSchema.parse(input.mood),
      moodCorrected: z.boolean().parse(input.moodCorrected),
      playlist: playlistSchema.parse(input.playlist),
      preferences: preferencesSchema.parse(
        input.preferences ?? { ...DEFAULT_PREFERENCES, length: input.playlist.requestedLength },
      ),
    };
  } catch {
    throw new HistoryError("INVALID_INPUT");
  }

  try {
    return await getDb().transaction(async (tx) => {
      const [created] = await tx
        .insert(photos)
        .values({ userId: valid.userId, saveId: valid.saveId, storageKey: valid.storageKey, palette: valid.palette })
        .onConflictDoNothing({ target: [photos.userId, photos.saveId] })
        .returning({ id: photos.id });
      if (!created) {
        const [existing] = await tx
          .select({ id: photos.id })
          .from(photos)
          .where(and(eq(photos.userId, valid.userId), eq(photos.saveId, valid.saveId)));
        if (!existing) throw new Error("conflicting photo row vanished");
        return existing.id;
      }

      const [analysis] = await tx
        .insert(analyses)
        .values({ photoId: created.id, mood: valid.mood, moodCorrected: valid.moodCorrected })
        .returning({ id: analyses.id });
      const [playlist] = await tx
        .insert(playlists)
        .values({
          analysisId: analysis.id,
          requestedLength: valid.playlist.requestedLength,
          featuredSpotifyId: valid.playlist.featuredTrackId,
          preferences: valid.preferences,
        })
        .returning({ id: playlists.id });
      await tx.insert(playlistTracks).values(
        valid.playlist.tracks.map((track, position) => ({
          playlistId: playlist.id,
          position,
          spotifyId: track.spotifyId,
          track,
        })),
      );
      return created.id;
    });
  } catch (error) {
    return safe(error);
  }
}

export interface PhotoSummary {
  id: string;
  primaryEmotion: PrimaryEmotion;
  createdAt: Date;
}

export interface PhotoList {
  photos: PhotoSummary[];
  /** Pass to the next call for older photos; null at the end. */
  nextCursor: string | null;
}

export const MAX_LIST_LIMIT = 100;

// created_at has microseconds, which a JS Date drops, so the cursor keeps the
// exact timestamp as text.
const cursorSchema = z.strictObject({ t: z.string().min(1).max(64), id: uuidSchema });

function encodeCursor(t: string, id: string): string {
  return Buffer.from(JSON.stringify({ t, id })).toString("base64url");
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new HistoryError("INVALID_CURSOR");
  }
}

/** The user's photos, newest first (ties by id), with primary emotion and date. */
export async function listPhotos(userId: string, options: { limit: number; cursor?: string }): Promise<PhotoList> {
  const limit = options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new HistoryError("INVALID_INPUT");
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);

  try {
    const exact = sql<string>`${photos.createdAt}::text`;
    const rows = await getDb()
      .select({ id: photos.id, createdAt: photos.createdAt, exact, mood: analyses.mood })
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
      photos: page.map((row) => ({
        id: row.id,
        primaryEmotion: moodResultSchema.parse(row.mood).primaryEmotion,
        createdAt: row.createdAt,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.exact, last.id) : null,
    };
  } catch (error) {
    return safe(error);
  }
}

export interface SavedPlaylist {
  id: string;
  requestedLength: PlaylistLength;
  featuredSpotifyId: string;
  preferences: Preferences;
  createdAt: Date;
  tracks: PlaylistTrack[];
}

export interface PhotoResult {
  id: string;
  storageKey: string;
  palette: PaletteResult;
  createdAt: Date;
  mood: MoodResult;
  moodCorrected: boolean;
  /** The most recent playlist; null if none exists. */
  playlist: SavedPlaylist | null;
}

/** The full saved result, or null when the photo is missing or another user's. */
export async function getPhotoResult(userId: string, photoId: string): Promise<PhotoResult | null> {
  if (!uuidSchema.safeParse(photoId).success) return null;
  try {
    const db = getDb();
    const [row] = await db
      .select({
        id: photos.id,
        storageKey: photos.storageKey,
        palette: photos.palette,
        createdAt: photos.createdAt,
        analysisId: analyses.id,
        mood: analyses.mood,
        moodCorrected: analyses.moodCorrected,
      })
      .from(photos)
      .innerJoin(analyses, eq(analyses.photoId, photos.id))
      .where(and(eq(photos.userId, userId), eq(photos.id, photoId)));
    if (!row) return null;

    const [latest] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.analysisId, row.analysisId))
      .orderBy(desc(playlists.createdAt), desc(playlists.id))
      .limit(1);
    let playlist: SavedPlaylist | null = null;
    if (latest) {
      const tracks = await db
        .select({ track: playlistTracks.track })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, latest.id))
        .orderBy(playlistTracks.position);
      playlist = {
        id: latest.id,
        requestedLength: latest.requestedLength as PlaylistLength,
        featuredSpotifyId: latest.featuredSpotifyId,
        preferences: preferencesSchema.parse(latest.preferences),
        createdAt: latest.createdAt,
        tracks: tracks.map((t) => playlistTrackSchema.parse(t.track)),
      };
    }
    return {
      id: row.id,
      storageKey: row.storageKey,
      palette: paletteSchema.parse(row.palette),
      createdAt: row.createdAt,
      mood: moodResultSchema.parse(row.mood),
      moodCorrected: row.moodCorrected,
      playlist,
    };
  } catch (error) {
    return safe(error);
  }
}

/** Deletes an owned photo (cascading) and returns its storage key, else null. */
export async function deletePhoto(userId: string, photoId: string): Promise<string | null> {
  if (!uuidSchema.safeParse(photoId).success) return null;
  try {
    const [deleted] = await getDb()
      .delete(photos)
      .where(and(eq(photos.userId, userId), eq(photos.id, photoId)))
      .returning({ storageKey: photos.storageKey });
    return deleted?.storageKey ?? null;
  } catch (error) {
    return safe(error);
  }
}
