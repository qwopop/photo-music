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
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

/**
 * A saved photo. Holds the storage key (`users/<userId>/<uuid>.<ext>`), never
 * image bytes. `save_id` is the client-generated idempotency key.
 */
export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    // A `PaletteResult` from lib/palette.
    palette: jsonb("palette").notNull(),
    saveId: uuid("save_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("photos_user_id_save_id_key").on(table.userId, table.saveId),
    index("photos_user_id_created_at_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
  ],
);

/** The mood of a photo: one per photo. */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    photoId: uuid("photo_id").notNull().unique().references(() => photos.id, { onDelete: "cascade" }),
    // A `MoodResult` from lib/mood.
    mood: jsonb("mood").notNull(),
    moodCorrected: boolean("mood_corrected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("analyses_photo_id_idx").on(table.photoId)],
);

/** One generated playlist; regenerations add more rows for the same analysis. */
export const playlists = pgTable(
  "playlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisId: uuid("analysis_id").notNull().references(() => analyses.id, { onDelete: "cascade" }),
    requestedLength: integer("requested_length").notNull(),
    featuredSpotifyId: text("featured_spotify_id").notNull(),
    // A `Preferences` from lib/preferences.
    preferences: jsonb("preferences").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("playlists_analysis_id_idx").on(table.analysisId),
    check("playlists_requested_length_check", sql`${table.requestedLength} in (5, 10, 20, 30)`),
  ],
);

export const playlistTracks = pgTable(
  "playlist_tracks",
  {
    playlistId: uuid("playlist_id").notNull().references(() => playlists.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    spotifyId: text("spotify_id").notNull(),
    // A `PlaylistTrack` from lib/playlist.
    track: jsonb("track").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.position] }),
    unique("playlist_tracks_playlist_id_spotify_id_key").on(table.playlistId, table.spotifyId),
  ],
);
