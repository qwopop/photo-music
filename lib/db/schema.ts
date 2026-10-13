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
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

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

/** Shared provider results, independent of any user's private data. */
export const youtubeLinkCache = pgTable(
  "youtube_link_cache",
  {
    title: text("title").notNull(),
    firstArtist: text("first_artist").notNull(),
    kind: text("kind").$type<"video" | "search">().notNull(),
    url: text("url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.title, table.firstArtist] }),
    check("youtube_link_cache_kind_check", sql`${table.kind} in ('video', 'search')`),
  ],
);
