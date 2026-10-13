import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { moodResultSchema, type MoodResult } from "../mood";
import { playlistSchema, youtubeLinkSchema, type Playlist, type PlaylistTrack } from "../playlist";
import { preferencesSchema, type Preferences } from "../preferences";
import { getDb, type Database } from "./index";
import { analyses, photos, playlistTracks, playlists } from "./schema";

const paletteSchema = z.strictObject({
  colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).length(6),
  brightness: z.number().min(0).max(1),
});

const inputSchema = z.strictObject({
  saveId: z.string().uuid(),
  storageKey: z.string().min(1),
  mood: moodResultSchema,
  moodCorrected: z.boolean(),
  palette: paletteSchema,
  preferences: preferencesSchema,
  playlist: playlistSchema,
});

export type SavePhotoResultInput = z.infer<typeof inputSchema>;

export class PhotoResultError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "DATA_UNAVAILABLE") {
    super(code === "INVALID_INPUT" ? "The photo result is invalid." : "The photo result could not be loaded.");
    this.name = "PhotoResultError";
  }
}

function validateInput(userId: string, input: SavePhotoResultInput): SavePhotoResultInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !userId || !UUID.test(userId)) throw new PhotoResultError("INVALID_INPUT");

  const expectedPrefix = `users/${userId}/`;
  if (
    !parsed.data.storageKey.startsWith(expectedPrefix) ||
    parsed.data.storageKey.includes("..") ||
    parsed.data.storageKey.includes("://") ||
    JSON.stringify(parsed.data.mood) !== JSON.stringify(parsed.data.playlist.mood) ||
    JSON.stringify(parsed.data.preferences) !== JSON.stringify(parsed.data.playlist.preferences)
  ) {
    throw new PhotoResultError("INVALID_INPUT");
  }
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatePhotoResultInput(userId: string, input: SavePhotoResultInput): SavePhotoResultInput {
  return validateInput(userId, input);
}

function trackRow(playlistId: string, track: PlaylistTrack, position: number) {
  return {
    playlistId,
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
  };
}

export async function savePhotoResult(
  userId: string,
  input: SavePhotoResultInput,
  db?: Database,
): Promise<{ id: string; created: boolean }> {
  const value = validateInput(userId, input);
  const database = db ?? getDb();
  try {
    return await database.transaction(async (tx) => {
      const [photo] = await tx
        .insert(photos)
        .values({ userId, storageKey: value.storageKey, saveId: value.saveId })
        .onConflictDoNothing({ target: [photos.userId, photos.saveId] })
        .returning({ id: photos.id });

      if (!photo) {
        const [existing] = await tx
          .select({ id: photos.id })
          .from(photos)
          .where(and(eq(photos.userId, userId), eq(photos.saveId, value.saveId)))
          .limit(1);
        if (!existing) throw new PhotoResultError("DATA_UNAVAILABLE");
        return { id: existing.id, created: false };
      }

      await tx.insert(analyses).values({
        photoId: photo.id,
        primaryEmotion: value.mood.primaryEmotion,
        secondaryMoods: value.mood.secondaryMoods,
        explanation: value.mood.explanation,
        confidence: value.mood.confidence,
        moodCorrected: value.moodCorrected,
        palette: value.palette,
        preferences: value.preferences,
      });

      const [playlist] = await tx
        .insert(playlists)
        .values({
          photoId: photo.id,
          requestedLength: value.playlist.requestedLength,
          featuredSpotifyId: value.playlist.featuredTrackId,
        })
        .returning({ id: playlists.id });

      await tx.insert(playlistTracks).values(value.playlist.tracks.map((track, position) => trackRow(playlist.id, track, position)));
      return { id: photo.id, created: true };
    });
  } catch (error) {
    if (error instanceof PhotoResultError) throw error;
    throw new PhotoResultError("DATA_UNAVAILABLE");
  }
}

export interface PhotoResult {
  id: string;
  storageKey: string;
  createdAt: Date;
  mood: MoodResult;
  moodCorrected: boolean;
  palette: { colors: string[]; brightness: number };
  preferences: Preferences;
  playlist: Playlist;
}

export async function getPhotoResultBySaveId(
  userId: string,
  saveId: string,
  db?: Database,
): Promise<{ id: string; storageKey: string } | null> {
  if (!UUID.test(userId) || !UUID.test(saveId)) throw new PhotoResultError("INVALID_INPUT");
  try {
    const [row] = await (db ?? getDb())
      .select({ id: photos.id, storageKey: photos.storageKey })
      .from(photos)
      .where(and(eq(photos.userId, userId), eq(photos.saveId, saveId)))
      .limit(1);
    return row ?? null;
  } catch {
    throw new PhotoResultError("DATA_UNAVAILABLE");
  }
}

function restoreTrack(track: typeof playlistTracks.$inferSelect): PlaylistTrack {
  return {
    spotifyId: track.spotifyId,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    artists: track.artists,
    album: track.album,
    durationMs: track.durationMs,
    coverImageUrl: track.coverImageUrl,
    youtube: youtubeLinkSchema.parse({ kind: track.youtubeKind, url: track.youtubeUrl }),
    matchReason: track.matchReason,
  };
}

export async function getPhotoResult(userId: string, id: string, db?: Database): Promise<PhotoResult | null> {
  try {
    const database = db ?? getDb();
    const [row] = await database
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
      .where(and(eq(photos.userId, userId), eq(photos.id, id)))
      .limit(1);
    if (!row) return null;

    const [savedPlaylist] = await database
      .select()
      .from(playlists)
      .where(eq(playlists.photoId, row.id))
      .orderBy(desc(playlists.createdAt))
      .limit(1);
    if (!savedPlaylist) throw new PhotoResultError("DATA_UNAVAILABLE");
    const rows = await database
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, savedPlaylist.id))
      .orderBy(playlistTracks.position);

    const mood = moodResultSchema.parse({
      primaryEmotion: row.primaryEmotion,
      secondaryMoods: row.secondaryMoods,
      explanation: row.explanation,
      confidence: row.confidence,
    });
    const preferences = preferencesSchema.parse(row.preferences);
    const playlist = playlistSchema.parse({
      mood,
      requestedLength: savedPlaylist.requestedLength,
      preferences,
      tracks: rows.map(restoreTrack),
      featuredTrackId: savedPlaylist.featuredSpotifyId,
    });
    const palette = paletteSchema.parse(row.palette);
    return {
      id: row.id,
      storageKey: row.storageKey,
      createdAt: row.createdAt,
      mood,
      moodCorrected: row.moodCorrected,
      palette,
      preferences,
      playlist,
    };
  } catch (error) {
    if (error instanceof PhotoResultError) throw error;
    throw new PhotoResultError("DATA_UNAVAILABLE");
  }
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z
      .strictObject({ createdAt: z.string().min(1), id: z.string().uuid() })
      .safeParse(value);
    if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.createdAt))) throw new Error();
    return parsed.data;
  } catch {
    throw new PhotoResultError("INVALID_INPUT");
  }
}

export async function listPhotoResults(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
  db?: Database,
): Promise<{
  items: { id: string; storageKey: string; createdAt: Date; primaryEmotion: string }[];
  nextCursor: string | null;
}> {
  const limit = options.limit ?? 20;
  if (!userId || !UUID.test(userId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new PhotoResultError("INVALID_INPUT");
  }
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);

  try {
    const query = (db ?? getDb())
      .select({
        id: photos.id,
        storageKey: photos.storageKey,
        createdAt: photos.createdAt,
        createdAtCursor: sql<string>`${photos.createdAt}::text`,
        primaryEmotion: analyses.primaryEmotion,
      })
      .from(photos)
      .innerJoin(analyses, eq(analyses.photoId, photos.id))
      .where(
        cursor
          ? and(
              eq(photos.userId, userId),
              sql`(${photos.createdAt}, ${photos.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
            )
          : eq(photos.userId, userId),
      )
      .orderBy(desc(photos.createdAt), desc(photos.id))
      .limit(limit + 1);
    const rows = await query;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((item) => ({
        id: item.id,
        storageKey: item.storageKey,
        createdAt: item.createdAt,
        primaryEmotion: item.primaryEmotion,
      })),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAtCursor, id: last.id }) : null,
    };
  } catch {
    throw new PhotoResultError("DATA_UNAVAILABLE");
  }
}

export async function deletePhotoResult(
  userId: string,
  id: string,
  db?: Database,
): Promise<string | null> {
  if (!userId || !UUID.test(userId) || !UUID.test(id)) return null;
  try {
    const [deleted] = await (db ?? getDb())
      .delete(photos)
      .where(and(eq(photos.userId, userId), eq(photos.id, id)))
      .returning({ storageKey: photos.storageKey });
    return deleted?.storageKey ?? null;
  } catch {
    throw new PhotoResultError("DATA_UNAVAILABLE");
  }
}
