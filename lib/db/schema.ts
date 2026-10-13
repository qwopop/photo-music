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
  unique,
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

// Saved results (#25). The values in the CHECK constraints below repeat
// PRIMARY_EMOTIONS (lib/mood) and PLAYLIST_LENGTHS (lib/playlist), because
// this file imports only from drizzle-orm; schema.test.ts checks that they
// agree.

/** A signed-in user's saved photo. Only the storage key is stored, never a URL. */
export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // The key from lib/storage, such as users/<userId>/<uuid>.jpg.
    storageKey: text("storage_key").notNull(),
    // Chosen by the caller; makes saving idempotent per user.
    saveId: uuid("save_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("photos_user_id_save_id_key").on(table.userId, table.saveId),
    unique("photos_storage_key_key").on(table.storageKey),
    index("photos_user_id_created_at_id_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
  ],
);

/** The mood analysis, palette and preferences of one photo. */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Unique: one analysis per photo (this is also its foreign-key index).
    photoId: uuid("photo_id").notNull().references(() => photos.id, { onDelete: "cascade" }),
    primaryEmotion: text("primary_emotion").notNull(),
    secondaryMoods: jsonb("secondary_moods").$type<string[]>().notNull(),
    explanation: text("explanation").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    moodCorrected: boolean("mood_corrected").notNull().default(false),
    palette: jsonb("palette").$type<{ colors: string[]; brightness: number }>().notNull(),
    preferences: jsonb("preferences").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("analyses_photo_id_key").on(table.photoId),
    check(
      "analyses_primary_emotion_check",
      sql`${table.primaryEmotion} in ('happy', 'sad', 'calm', 'energetic', 'romantic')`,
    ),
    check("analyses_confidence_check", sql`${table.confidence} >= 0 and ${table.confidence} <= 1`),
    check(
      "analyses_secondary_moods_check",
      sql`jsonb_typeof(${table.secondaryMoods}) = 'array' and jsonb_array_length(${table.secondaryMoods}) <= 3`,
    ),
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
    id: uuid("id").primaryKey().defaultRandom(),
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
    // The first of these is also the foreign-key index on playlist_id.
    unique("playlist_tracks_playlist_id_position_key").on(table.playlistId, table.position),
    unique("playlist_tracks_playlist_id_spotify_id_key").on(table.playlistId, table.spotifyId),
    check("playlist_tracks_youtube_kind_check", sql`${table.youtubeKind} in ('video', 'search')`),
    check("playlist_tracks_position_check", sql`${table.position} >= 0`),
  ],
);
