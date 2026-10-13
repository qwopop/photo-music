import { describe, expect, it } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { PLAYLIST_EXAMPLES } from "../playlist";
import { PhotoResultError, validatePhotoResultInput } from "./photo-results";

const userId = "7a93c9ab-8389-48a0-a854-f063bb18406d";
const valid = {
  saveId: "828b4289-877e-46a8-9cfb-488c8d1c226b",
  storageKey: `users/${userId}/828b4289-877e-46a8-9cfb-488c8d1c226b.jpg`,
  mood: MOOD_EXAMPLES[0],
  moodCorrected: false,
  palette: {
    colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"],
    brightness: 0.5,
  },
  preferences: PLAYLIST_EXAMPLES[0].preferences,
  playlist: PLAYLIST_EXAMPLES[0],
};

describe("saved photo result input validation", () => {
  it("accepts shared mood, palette, preferences, and playlist fixtures", () => {
    expect(validatePhotoResultInput(userId, valid)).toEqual(valid);
  });

  it("rejects a non-UUID save id before any database access", () => {
    expect(() => validatePhotoResultInput(userId, { ...valid, saveId: "not-a-uuid" })).toThrow(PhotoResultError);
  });

  it.each(["", "https://example.com/photo.jpg", `users/${userId}/../other/photo.jpg`, "users/someone-else/photo.jpg"])(
    "rejects an invalid/private-prefix storage key: %s",
    (storageKey) => {
      expect(() => validatePhotoResultInput(userId, { ...valid, storageKey })).toThrow(PhotoResultError);
    },
  );

  it("rejects a playlist whose mood differs from the stored mood", () => {
    expect(() =>
      validatePhotoResultInput(userId, {
        ...valid,
        mood: MOOD_EXAMPLES[1],
      }),
    ).toThrow(PhotoResultError);
  });

  it("rejects a playlist whose preferences differ from the stored preferences", () => {
    expect(() =>
      validatePhotoResultInput(userId, {
        ...valid,
        preferences: { ...valid.preferences, length: 10 },
      }),
    ).toThrow(PhotoResultError);
  });

  it("rejects duplicate playlist tracks", () => {
    const track = PLAYLIST_EXAMPLES[0].tracks[0];
    expect(() =>
      validatePhotoResultInput(userId, {
        ...valid,
        playlist: { ...valid.playlist, tracks: [track, track] },
      }),
    ).toThrow(PhotoResultError);
  });

  it("rejects an invalid owner id", () => {
    expect(() => validatePhotoResultInput("not-a-uuid", valid)).toThrow(PhotoResultError);
  });
});
