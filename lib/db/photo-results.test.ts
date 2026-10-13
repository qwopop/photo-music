import { describe, expect, it } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import type { Database } from "./index";
import {
  listPhotoResults,
  PhotoResultError,
  savePhotoResult,
  type SavePhotoResultInput,
} from "./photo-results";

// Validation runs before any database use, so these tests pass a db that
// fails on any use. Real PostgreSQL behavior is in photo-results.db.test.ts.

const noDb = new Proxy({}, { get: () => { throw new Error("The database must not be used."); } }) as Database;
const USER = "11111111-1111-4111-8111-111111111111";

function valid(): SavePhotoResultInput {
  const playlist = structuredClone(PLAYLIST_EXAMPLES[0]);
  return {
    saveId: "22222222-2222-4222-8222-222222222222",
    storageKey: `users/${USER}/33333333-3333-4333-8333-333333333333.jpg`,
    mood: structuredClone(playlist.mood),
    moodCorrected: false,
    palette: { colors: ["#112233", "#445566"], brightness: 0.5 },
    preferences: { ...DEFAULT_PREFERENCES },
    playlist,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PhotoResultError) return error.code;
    throw error;
  }
  throw new Error("Expected a PhotoResultError.");
}

describe("savePhotoResult input validation", () => {
  const cases: [string, (input: SavePhotoResultInput) => void][] = [
    ["an unknown emotion", (i) => { (i.mood as { primaryEmotion: string }).primaryEmotion = "angry"; }],
    ["more than 3 secondary moods", (i) => { i.mood.secondaryMoods = ["a", "b", "c", "d"]; }],
    ["a confidence above 1", (i) => { i.mood.confidence = 1.1; }],
    ["a confidence below 0", (i) => { i.mood.confidence = -0.1; }],
    ["a duplicate track", (i) => { i.playlist.tracks[1] = { ...i.playlist.tracks[0] }; }],
    ["a featured id that is not in the tracks", (i) => { i.playlist.featuredTrackId = "NotInTheTracks0000000000"; }],
    ["an empty storageKey", (i) => { i.storageKey = ""; }],
    ["a saveId that is not a uuid", (i) => { i.saveId = "not-a-uuid"; }],
    ["invalid preferences", (i) => { (i.preferences as { length: number }).length = 7; }],
    ["a playlist mood that differs from the mood", (i) => { i.playlist.mood = MOOD_EXAMPLES[1]; }],
  ];

  it.each(cases)("rejects %s before any write", async (_, change) => {
    const input = valid();
    change(input);
    expect(await codeOf(savePhotoResult(USER, input, noDb))).toBe("INVALID_INPUT");
  });

  it("rejects a userId that is not a uuid", async () => {
    expect(await codeOf(savePhotoResult("nobody", valid(), noDb))).toBe("INVALID_INPUT");
  });
});

describe("listPhotoResults arguments", () => {
  it.each([0, 101, -1, 1.5, Number.NaN])("rejects limit %s", async (limit) => {
    expect(await codeOf(listPhotoResults(USER, { limit }, noDb))).toBe("INVALID_LIMIT");
  });

  it.each(["", "not base64 json", Buffer.from("[1,2]").toString("base64url")])("rejects the cursor %j", async (cursor) => {
    expect(await codeOf(listPhotoResults(USER, { cursor }, noDb))).toBe("INVALID_CURSOR");
  });
});

describe("PhotoResultError", () => {
  it("has a fixed message and no cause", () => {
    const error = new PhotoResultError("DATABASE_ERROR");
    expect(error.message).toBe("The database could not complete the request.");
    expect(error.cause).toBeUndefined();
  });
});
