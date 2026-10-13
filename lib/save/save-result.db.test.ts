import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { connectionSettings } from "../db/connection";
import type { Database } from "../db";
import { savePhotoResult } from "../db/photo-results";
import * as schema from "../db/schema";
import { photos, users } from "../db/schema";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import { TemporaryUploadStore } from "../upload/store";
import { resetSaveRuns, saveResult } from "./save-result";

// Runs with `npm run test:db`: the real repository, fake storage.
const pool = new Pool(connectionSettings({ url: inject("testDatabaseUrl") }));
const db = drizzle({ client: pool, schema }) as Database;
const bytes = readFileSync("lib/upload/fixtures/sample.jpg");

beforeEach(async () => {
  resetSaveRuns();
  await db.delete(users);
});
afterAll(() => pool.end());

describe("saveResult with the real repository", () => {
  it("saves once, even when called twice", async () => {
    const [user] = await db.insert(users).values({ email: "s@example.com", passwordHash: "x" }).returning({ id: users.id });
    const uploads = new TemporaryUploadStore();
    const objects = new Set<string>();
    const deps = {
      getCurrentUser: async () => ({ id: user.id }),
      uploads,
      uploadPhoto: vi.fn(async ({ userId }: { userId: string }) => {
        const key = `users/${userId}/${randomUUID()}.jpg`;
        objects.add(key);
        return key;
      }),
      deletePhoto: async (key: string) => void objects.delete(key),
      extractPalette: async () => ({ colors: ["#000000"], brightness: 0.5 }),
      savePhotoResult: (userId: string, input: Parameters<typeof savePhotoResult>[1]) => savePhotoResult(userId, input, db),
    };
    const input = {
      uploadHandle: uploads.put({ bytes, mimeType: "image/jpeg" }).id,
      saveId: randomUUID(),
      mood: MOOD_EXAMPLES[0],
      moodCorrected: false,
      playlist: PLAYLIST_EXAMPLES[0],
      preferences: DEFAULT_PREFERENCES,
    };
    const first = await saveResult(input, deps);
    resetSaveRuns(); // simulate another process: the database must dedupe
    const again = { ...input, uploadHandle: uploads.put({ bytes, mimeType: "image/jpeg" }).id };
    const second = await saveResult(again, deps);
    expect(first).toMatchObject({ status: "saved" });
    expect(second).toEqual(first);
    expect(await db.select().from(photos)).toHaveLength(1);
    expect(objects.size).toBe(1);
  });
});
