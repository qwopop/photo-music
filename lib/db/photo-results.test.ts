import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import type { Database } from "./index";
import {
  deletePhotoResult,
  getPhotoResult,
  listPhotoResults,
  savePhotoResult,
  validateSavePhotoResultInput,
  type SavePhotoResultInput,
} from "./photo-results";

// No database: a db that fails on any use proves nothing is written or read.
const untouchable = new Proxy({}, { get: () => { throw new Error("database used"); } }) as unknown as Database;
const userId = randomUUID();

function valid(overrides: Partial<SavePhotoResultInput> = {}): SavePhotoResultInput {
  return {
    saveId: randomUUID(),
    storageKey: `users/${userId}/${randomUUID()}.jpg`,
    mood: MOOD_EXAMPLES[0],
    moodCorrected: false,
    palette: { colors: ["#112233"], brightness: 0.5 },
    preferences: DEFAULT_PREFERENCES,
    playlist: PLAYLIST_EXAMPLES[0],
    ...overrides,
  };
}

describe("savePhotoResult validation", () => {
  it("accepts valid input", () => {
    expect(() => validateSavePhotoResultInput(userId, valid())).not.toThrow();
  });

  const track = PLAYLIST_EXAMPLES[0].tracks;
  it.each<[string, Partial<SavePhotoResultInput>]>([
    ["an unknown emotion", { mood: { ...MOOD_EXAMPLES[0], primaryEmotion: "angry" as never } }],
    ["more than 3 secondary moods", { mood: { ...MOOD_EXAMPLES[0], secondaryMoods: ["a", "b", "c", "d"] } }],
    ["confidence above 1", { mood: { ...MOOD_EXAMPLES[0], confidence: 1.1 } }],
    ["confidence below 0", { mood: { ...MOOD_EXAMPLES[0], confidence: -0.1 } }],
    ["a duplicate track", { playlist: { ...PLAYLIST_EXAMPLES[0], tracks: [track[0], track[0]] } }],
    ["a featured id not in the tracks", { playlist: { ...PLAYLIST_EXAMPLES[0], featuredTrackId: "x" } }],
    ["an empty storage key", { storageKey: "" }],
    ["a saveId that is not a uuid", { saveId: "not-a-uuid" }],
    ["invalid preferences", { preferences: { ...DEFAULT_PREFERENCES, length: 7 as never } }],
  ])("rejects %s before touching the database", async (_name, overrides) => {
    await expect(savePhotoResult(userId, valid(overrides), untouchable)).rejects.toMatchObject({
      name: "PhotoResultError",
      code: "INVALID_INPUT",
    });
  });
});

describe("listPhotoResults arguments", () => {
  it.each([0, 101, 1.5, -1, Number.NaN])("rejects limit %s", async (limit) => {
    await expect(listPhotoResults(userId, { limit }, untouchable)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  });

  it("rejects a malformed cursor", async () => {
    await expect(listPhotoResults(userId, { cursor: "garbage" }, untouchable)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("ids that are not uuids", () => {
  it("find and delete nothing without querying", async () => {
    expect(await getPhotoResult(userId, "nope", untouchable)).toBeNull();
    expect(await deletePhotoResult(userId, "nope", untouchable)).toBeNull();
  });
});

describe("database errors", () => {
  it("become a safe error without the message or parameters", async () => {
    const secret = "secret-parameter";
    const failing = {
      transaction: async () => {
        throw new Error(`insert into photos values ('${secret}')`);
      },
    } as unknown as Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await savePhotoResult(userId, valid(), failing).catch((e: unknown) => e as Error) as Error;
    expect(error).toMatchObject({ name: "PhotoResultError", code: "DATABASE_ERROR" });
    expect(JSON.stringify([error.message, error.cause, logged.mock.calls])).not.toContain(secret);
    logged.mockRestore();
  });
});
