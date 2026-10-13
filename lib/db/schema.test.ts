import { readdirSync, readFileSync } from "node:fs";
import { Column, is } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import drizzleConfig from "../../drizzle.config";
import { analyses, photos, playlists, playlistTracks, users } from "./schema";

// Checks the schema, drizzle.config.ts and the committed migration files
// without a database. `npm run test:db` checks the tables they create.

const migrationsFolder = new URL("./migrations/", import.meta.url);

describe("lib/db/schema.ts", () => {
  it("imports only from drizzle-orm, with no server-only, lib/config or @/ alias", () => {
    const source = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^drizzle-orm(\/|$)/);
    }
    expect(source).not.toMatch(/^\s*import\s+["'][^"']+["']/m);
  });

  it("names every users column in snake_case, after its property", () => {
    const { name } = getTableConfig(users);
    expect(name).toBe("users");
    const columns = Object.entries(users).filter(([, value]) => is(value, Column)) as [string, Column][];
    expect(columns.map(([key]) => key)).toEqual(expect.arrayContaining(["id", "email", "passwordHash", "createdAt"]));
    for (const [key, column] of columns) {
      expect(column.name, key).toBe(key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
    }
  });

  it("has a unique index users_email_lower_key on lower(email)", () => {
    const { indexes } = getTableConfig(users);
    expect(indexes.map((index) => [index.config.name, index.config.unique])).toEqual([["users_email_lower_key", true]]);
  });
});

describe("the saved results tables", () => {
  const config = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table);
  const names = (table: Parameters<typeof getTableConfig>[0]) => config(table).columns.map((column) => column.name);

  it("have the expected columns, in snake_case", () => {
    expect(names(photos)).toEqual(["id", "user_id", "storage_key", "save_id", "created_at"]);
    expect(names(analyses)).toEqual([
      "id", "photo_id", "primary_emotion", "secondary_moods", "explanation", "confidence",
      "mood_corrected", "palette", "preferences", "created_at",
    ]);
    expect(names(playlists)).toEqual(["id", "photo_id", "requested_length", "featured_spotify_id", "created_at"]);
    expect(names(playlistTracks)).toEqual([
      "playlist_id", "position", "spotify_id", "spotify_url", "title", "artists", "album", "duration_ms",
      "cover_image_url", "youtube_kind", "youtube_url", "match_reason",
    ]);
  });

  it("cascade from users and photos", () => {
    const onDelete = (table: Parameters<typeof getTableConfig>[0]) =>
      config(table).foreignKeys.map((fk) => [fk.reference().foreignTable === users, fk.onDelete]);
    expect(onDelete(photos)).toEqual([[true, "cascade"]]);
    expect(config(analyses).foreignKeys.map((fk) => fk.onDelete)).toEqual(["cascade"]);
    expect(config(playlists).foreignKeys.map((fk) => fk.onDelete)).toEqual(["cascade"]);
    expect(config(playlistTracks).foreignKeys.map((fk) => fk.onDelete)).toEqual(["cascade"]);
  });

  it("have the unique keys, CHECK constraints and indexes", () => {
    expect(config(photos).uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual([["user_id", "save_id"]]);
    const uniqueColumns = (table: Parameters<typeof getTableConfig>[0]) =>
      config(table).columns.filter((column) => column.isUnique).map((column) => column.name);
    expect(uniqueColumns(photos)).toEqual(["storage_key"]);
    expect(uniqueColumns(analyses)).toEqual(["photo_id"]);
    expect(config(playlistTracks).uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual([["playlist_id", "spotify_id"]]);
    expect(config(playlistTracks).primaryKeys[0].columns.map((c) => c.name)).toEqual(["playlist_id", "position"]);
    expect(config(analyses).checks.map((c) => c.name).sort()).toEqual(["analyses_confidence_check", "analyses_primary_emotion_check"]);
    expect(config(playlists).checks.map((c) => c.name)).toEqual(["playlists_requested_length_check"]);
    expect(config(photos).indexes.map((i) => i.config.name)).toEqual(["photos_user_id_created_at_id_idx"]);
    expect(config(playlists).indexes.map((i) => i.config.name)).toEqual(["playlists_photo_id_idx"]);
  });
});

describe("drizzle.config.ts", () => {
  it("sets only the dialect, the schema and the migrations folder, with no credentials", () => {
    expect(drizzleConfig).toStrictEqual({
      dialect: "postgresql",
      schema: "./lib/db/schema.ts",
      out: "./lib/db/migrations",
    });
  });
});

describe("lib/db/migrations", () => {
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrationsFolder), "utf8")) as {
    entries: { tag: string; when: number }[];
  };

  it("starts with 0000_create_users", () => {
    expect(journal.entries[0].tag).toBe("0000_create_users");
  });

  it("has a SQL file for every journal entry, and no other", () => {
    const sqlFiles = readdirSync(migrationsFolder).filter((file) => file.endsWith(".sql"));
    expect(sqlFiles.sort()).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`).sort());
  });

  it("has no CREATE EXTENSION", () => {
    for (const { tag } of journal.entries) {
      const sql = readFileSync(new URL(`${tag}.sql`, migrationsFolder), "utf8");
      expect(sql, tag).not.toMatch(/create\s+extension/i);
    }
  });
});
