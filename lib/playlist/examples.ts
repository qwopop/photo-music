import { MOOD_EXAMPLES } from "../mood";
import { DEFAULT_PREFERENCES } from "../preferences";
import type { Playlist, PlaylistTrack } from "./index";

// Synthetic fixtures for tests and documentation only. They are not real songs
// or provider responses and must never be shown to users as recommendations.

function track(n: number, extra: Partial<PlaylistTrack> = {}): PlaylistTrack {
  const spotifyId = `ExampleTrackId${String(n).padStart(8, "0")}`;
  return {
    spotifyId,
    spotifyUrl: `https://open.spotify.com/track/${spotifyId}`,
    title: `Example Song ${n}`,
    artists: ["Example Artist"],
    album: `Example Album ${n}`,
    durationMs: 180_000 + n * 1_000,
    coverImageUrl: `https://example.com/covers/${n}.jpg`,
    youtube: { kind: "video", url: `https://www.youtube.com/watch?v=exampleId${String(n).padStart(2, "0")}` },
    matchReason: "Its unhurried piano could suit the calm evening light.",
    ...extra,
  };
}

const tracks = (count: number) => Array.from({ length: count }, (_, i) => track(i + 1));

export const PLAYLIST_EXAMPLES = [
  // Full playlist: tracks.length === requestedLength, featured track first.
  {
    mood: MOOD_EXAMPLES[0],
    requestedLength: 5,
    preferences: { ...DEFAULT_PREFERENCES, length: 5 },
    tracks: tracks(5),
    featuredTrackId: track(1).spotifyId,
  },
  // Short playlist, featured track not first, multi-artist track, both YouTube kinds.
  {
    mood: MOOD_EXAMPLES[2],
    requestedLength: 10,
    preferences: {
      genres: ["jazz", "lo-fi"],
      artists: ["Example Artist"],
      languages: ["english", "french"],
      situation: "relaxing",
      length: 10,
    },
    tracks: [
      track(1),
      track(2, {
        artists: ["Example Artist", "Another Example Artist"],
        youtube: { kind: "search", url: "https://www.youtube.com/results?search_query=Example%20Song%202%20Example%20Artist" },
      }),
      track(3),
    ],
    featuredTrackId: track(2).spotifyId,
  },
  // No album and no artwork.
  {
    mood: MOOD_EXAMPLES[4],
    requestedLength: 5,
    preferences: { ...DEFAULT_PREFERENCES, length: 5 },
    tracks: [track(7, { album: null, coverImageUrl: null })],
    featuredTrackId: track(7).spotifyId,
  },
] satisfies Playlist[];
