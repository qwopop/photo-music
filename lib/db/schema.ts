/**
 * The database tables, as Drizzle schema.
 *
 * `drizzle-kit generate` (`npm run db:generate`) compares this file with the
 * last snapshot in `migrations/meta/` and writes a SQL migration for the
 * difference. To change a table, edit it here, generate a migration, review
 * its SQL and commit both together (see "Database schema and migrations" in
 * the README).
 *
 * This file imports only from `drizzle-orm`, with relative paths and no `@/`
 * alias, so that `drizzle-kit`, scripts and tests can load it outside
 * Next.js. Every column is named in snake_case here, such as
 * `text("password_hash")`, and Drizzle's `casing` option is not used, so the
 * migrations and the runtime client always agree about names.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** `lower(column)`, for case-insensitive comparisons and indexes. */
export function lower(column: AnyPgColumn): SQL {
  return sql`lower(${column})`;
}

export const users = pgTable(
  "users",
  {
    // gen_random_uuid() is built into PostgreSQL 13 and later, so the
    // migration needs no extension.
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored as entered. Uniqueness ignores letter case (see the index).
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_lower_key").on(lower(table.email))],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the private cookie token, never the token itself.
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    saveId: uuid("save_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("photos_user_save_id_key").on(table.userId, table.saveId),
    uniqueIndex("photos_storage_key_key").on(table.storageKey),
    index("photos_user_created_id_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
  ],
);

export const analyses = pgTable(
  "analyses",
  {
    photoId: uuid("photo_id").primaryKey().references(() => photos.id, { onDelete: "cascade" }),
    primaryEmotion: text("primary_emotion").notNull(),
    secondaryMoods: jsonb("secondary_moods").$type<string[]>().notNull(),
    explanation: text("explanation").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    moodCorrected: boolean("mood_corrected").notNull().default(false),
    palette: jsonb("palette")
      .$type<{ colors: string[]; brightness: number }>()
      .notNull(),
    preferences: jsonb("preferences")
      .$type<{
        genres: string[];
        artists: string[];
        languages: string[];
        situation: string | null;
        length: 5 | 10 | 20 | 30;
      }>()
      .notNull(),
  },
  (table) => [
    check(
      "analyses_primary_emotion_check",
      sql`${table.primaryEmotion} in ('happy', 'sad', 'calm', 'energetic', 'romantic')`,
    ),
    check("analyses_confidence_check", sql`${table.confidence} between 0 and 1`),
  ],
);

export const playlists = pgTable(
  "playlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    photoId: uuid("photo_id").notNull().references(() => photos.id, { onDelete: "cascade" }),
    requestedLength: integer("requested_length").notNull(),
    featuredSpotifyId: text("featured_spotify_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("playlists_photo_id_idx").on(table.photoId),
    check("playlists_requested_length_check", sql`${table.requestedLength} in (5, 10, 20, 30)`),
  ],
);

export const playlistTracks = pgTable(
  "playlist_tracks",
  {
    playlistId: uuid("playlist_id").notNull().references(() => playlists.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    spotifyId: text("spotify_id").notNull(),
    spotifyUrl: text("spotify_url").notNull(),
    title: text("title").notNull(),
    artists: jsonb("artists").$type<string[]>().notNull(),
    album: text("album"),
    durationMs: integer("duration_ms").notNull(),
    coverImageUrl: text("cover_image_url"),
    youtubeKind: text("youtube_kind").notNull(),
    youtubeUrl: text("youtube_url").notNull(),
    matchReason: text("match_reason").notNull(),
  },
  (table) => [
    uniqueIndex("playlist_tracks_playlist_position_key").on(table.playlistId, table.position),
    uniqueIndex("playlist_tracks_playlist_spotify_key").on(table.playlistId, table.spotifyId),
    check("playlist_tracks_position_check", sql`${table.position} >= 0`),
    check("playlist_tracks_youtube_kind_check", sql`${table.youtubeKind} in ('video', 'search')`),
  ],
);
