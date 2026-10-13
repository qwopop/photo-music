import { z } from "zod";
import { moodResultSchema } from "../mood";

/** Playlist sizes the user can choose (plan decision 8). */
export const PLAYLIST_LENGTHS = [5, 10, 20, 30] as const;
const playlistLengthSchema = z.literal(PLAYLIST_LENGTHS);

export type PlaylistLength = z.infer<typeof playlistLengthSchema>;

const nonBlank = (max: number, what: string) =>
  z.string().min(1).max(max).regex(/\S/, `${what} must contain a non-whitespace character.`);

// URLs use plain regexes, not z.url(): z.url() trims whitespace and the
// protocol option only becomes `format: "uri"` in the JSON Schema.
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
const SPOTIFY_TRACK_URL_PREFIX = "https://open.spotify.com/track/";

const trackShape = {
  spotifyId: z.string().regex(SPOTIFY_ID, "A Spotify ID is 22 letters and digits."),
  spotifyUrl: z.string().regex(/^https:\/\/open\.spotify\.com\/track\/[0-9A-Za-z]{22}$/),
  title: nonBlank(500, "A title"),
  artists: z.array(nonBlank(200, "An artist name")).min(1).max(50),
  album: nonBlank(500, "An album name").nullable(),
  durationMs: z.number().int().min(1).max(86_400_000),
  coverImageUrl: z.string().max(2048).regex(/^https:\/\/\S+$/).nullable(),
};

// Zod-only rule (JSON Schema cannot express it): the URL names this track.
function checkSpotifyUrl(value: { spotifyId: string; spotifyUrl: string }, ctx: z.RefinementCtx) {
  if (value.spotifyUrl !== SPOTIFY_TRACK_URL_PREFIX + value.spotifyId) {
    ctx.addIssue({ code: "custom", path: ["spotifyUrl"], message: "spotifyUrl must end with this track's spotifyId." });
  }
}

/** One catalog track, as a music provider returns it. */
export const trackSchema = z.strictObject(trackShape).superRefine(checkSpotifyUrl);
export type Track = z.infer<typeof trackSchema>;

/** A found video, or the search-link fallback when none was found. */
export const youtubeLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("video"),
    url: z.string().regex(/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/),
  }),
  z.strictObject({
    kind: z.literal("search"),
    url: z.string().regex(/^https:\/\/www\.youtube\.com\/results\?search_query=[^\s&#]+$/),
  }),
]);
export type YouTubeLink = z.infer<typeof youtubeLinkSchema>;

/** A Track plus its YouTube link and why it could suit the photo's mood. */
export const playlistTrackSchema = z
  .strictObject({
    ...trackShape,
    youtube: youtubeLinkSchema,
    matchReason: nonBlank(300, "A match reason"),
  })
  .superRefine(checkSpotifyUrl);
export type PlaylistTrack = z.infer<typeof playlistTrackSchema>;

export const playlistSchema = z
  .strictObject({
    mood: moodResultSchema,
    requestedLength: playlistLengthSchema,
    tracks: z.array(playlistTrackSchema).min(1),
    featuredTrackId: z.string(),
  })
  .superRefine((playlist, ctx) => {
    // Zod-only rules: JSON Schema cannot express these.
    if (playlist.tracks.length > playlist.requestedLength) {
      ctx.addIssue({ code: "custom", path: ["tracks"], message: "A playlist cannot have more tracks than requestedLength." });
    }
    const seen = new Set<string>();
    playlist.tracks.forEach((track, index) => {
      if (seen.has(track.spotifyId)) {
        ctx.addIssue({ code: "custom", path: ["tracks", index, "spotifyId"], message: "Track IDs must be unique." });
      }
      seen.add(track.spotifyId);
    });
    if (!seen.has(playlist.featuredTrackId)) {
      ctx.addIssue({ code: "custom", path: ["featuredTrackId"], message: "featuredTrackId must be the spotifyId of a listed track." });
    }
  });
export type Playlist = z.infer<typeof playlistSchema>;

/** Draft-2020-12 JSON Schema from the same Zod source (without the four Zod-only rules). */
export const playlistJsonSchema = z.toJSONSchema(playlistSchema);

export { PLAYLIST_EXAMPLES } from "./examples";
