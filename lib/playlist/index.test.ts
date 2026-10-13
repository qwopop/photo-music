import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { MOOD_EXAMPLES, type MoodResult } from "../mood";
import { DEFAULT_PREFERENCES, PREFERENCE_LENGTHS, type Preferences } from "../preferences";
import {
  PLAYLIST_EXAMPLES, PLAYLIST_LENGTHS, playlistJsonSchema, playlistSchema, playlistTrackSchema,
  trackSchema, youtubeLinkSchema,
  type Playlist, type PlaylistLength, type PlaylistTrack, type Track, type YouTubeLink,
} from "./index";

const ok = (schema: z.ZodType, v: unknown) => schema.safeParse(v).success;
const clone = <T,>(v: T): T => structuredClone(v);
const base: PlaylistTrack = PLAYLIST_EXAMPLES[0].tracks[0];
const { youtube: _y, matchReason: _m, ...trackOnly } = base;
void _y; void _m;
const playlist: Playlist = PLAYLIST_EXAMPLES[0];
const id = (n: number) => `ExampleTrackId${String(n).padStart(8, "0")}`;
const withId = (n: number): PlaylistTrack => ({ ...base, spotifyId: id(n), spotifyUrl: `https://open.spotify.com/track/${id(n)}` });
const many = (n: number) => Array.from({ length: n }, (_, i) => withId(i + 1));

describe("types", () => {
  it("are inferred from the schemas", () => {
    expect(PLAYLIST_LENGTHS).toEqual([5, 10, 20, 30]);
    expectTypeOf<PlaylistLength>().toEqualTypeOf<5 | 10 | 20 | 30>();
    expectTypeOf<Track>().toEqualTypeOf<z.infer<typeof trackSchema>>();
    expectTypeOf<YouTubeLink>().toEqualTypeOf<z.infer<typeof youtubeLinkSchema>>();
    expectTypeOf<PlaylistTrack>().toEqualTypeOf<z.infer<typeof playlistTrackSchema>>();
    expectTypeOf<Playlist>().toEqualTypeOf<z.infer<typeof playlistSchema>>();
    expectTypeOf<Playlist["mood"]>().toEqualTypeOf<MoodResult>();
    expectTypeOf<Playlist["preferences"]>().toEqualTypeOf<Preferences>();
    const link = {} as YouTubeLink;
    if (link.kind === "video") expectTypeOf(link).toEqualTypeOf<{ kind: "video"; url: string }>();
    else expectTypeOf(link).toEqualTypeOf<{ kind: "search"; url: string }>();
  });
});

describe("fixtures", () => {
  it.each(PLAYLIST_EXAMPLES.map((p, i) => [i, p] as const))("example %i parses unchanged", (_i, p) => {
    expect(playlistSchema.parse(p)).toEqual(p);
    for (const t of p.tracks) expect(playlistTrackSchema.parse(t)).toEqual(t);
    expect(MOOD_EXAMPLES).toContainEqual(p.mood);
  });
  it("cover the required cases", () => {
    const all = PLAYLIST_EXAMPLES;
    const tracks = all.flatMap((p) => p.tracks);
    expect(all.some((p) => p.tracks.length === p.requestedLength)).toBe(true);
    expect(all.some((p) => p.tracks.length < p.requestedLength)).toBe(true);
    expect(all.some((p) => p.tracks[0].spotifyId !== p.featuredTrackId)).toBe(true);
    expect(tracks.some((t) => t.artists.length === 1)).toBe(true);
    expect(tracks.some((t) => t.artists.length > 1)).toBe(true);
    expect(tracks.some((t) => t.album === null && t.coverImageUrl === null)).toBe(true);
    expect(all.some((p) => p.preferences.genres.length > 0 && p.preferences.artists.length > 0
      && p.preferences.languages.length > 0 && p.preferences.situation !== null)).toBe(true);
    expect(all.some((p) => p.preferences.genres.length === 0 && p.preferences.situation === null)).toBe(true);
    for (const p of all) expect(p.preferences.length).toBe(p.requestedLength);
    expect(new Set(tracks.map((t) => t.youtube.kind))).toEqual(new Set(["video", "search"]));
    for (const t of tracks) if (t.coverImageUrl) expect(t.coverImageUrl).toMatch(/^https:\/\/example\.com\//);
  });
});

describe("trackSchema", () => {
  it("accepts a valid track and rejects extra YouTube fields", () => {
    expect(trackSchema.parse(trackOnly)).toEqual(trackOnly);
    expect(ok(trackSchema, base)).toBe(false);
  });
  it.each(Object.keys(trackOnly))("requires %s and rejects undefined", (f) => {
    const m: Record<string, unknown> = clone(trackOnly);
    delete m[f];
    expect(ok(trackSchema, m)).toBe(false);
    expect(ok(trackSchema, { ...trackOnly, [f]: undefined })).toBe(false);
  });
  it.each(["spotifyId", "spotifyUrl", "title", "artists", "durationMs"])("rejects null %s", (f) => {
    expect(ok(trackSchema, { ...trackOnly, [f]: null })).toBe(false);
  });
  it("accepts null album and cover", () => {
    expect(ok(trackSchema, { ...trackOnly, album: null, coverImageUrl: null })).toBe(true);
  });
  it.each([["title", 1], ["artists", "x"], ["artists", [1]], ["album", 1], ["durationMs", "5"], ["spotifyId", 1], ["coverImageUrl", 1]])(
    "rejects wrong type %s=%j", (f, v) => expect(ok(trackSchema, { ...trackOnly, [f as string]: v })).toBe(false));
  it("rejects unknown properties", () => expect(ok(trackSchema, { ...trackOnly, popularity: 1 })).toBe(false));

  it.each(["", " ", "\t\n", " "])("rejects blank text %j", (b) => {
    expect(ok(trackSchema, { ...trackOnly, title: b })).toBe(false);
    expect(ok(trackSchema, { ...trackOnly, album: b })).toBe(false);
    expect(ok(trackSchema, { ...trackOnly, artists: [b] })).toBe(false);
  });
  it.each([["title", 500], ["album", 500]])("%s limit %i", (f, n) => {
    expect(ok(trackSchema, { ...trackOnly, [f]: "x".repeat(n as number) })).toBe(true);
    expect(ok(trackSchema, { ...trackOnly, [f]: "x".repeat((n as number) + 1) })).toBe(false);
  });
  it("artist limits", () => {
    expect(ok(trackSchema, { ...trackOnly, artists: ["x".repeat(200)] })).toBe(true);
    expect(ok(trackSchema, { ...trackOnly, artists: ["x".repeat(201)] })).toBe(false);
    expect(ok(trackSchema, { ...trackOnly, artists: [] })).toBe(false);
    expect(ok(trackSchema, { ...trackOnly, artists: Array(50).fill("a") })).toBe(true);
    expect(ok(trackSchema, { ...trackOnly, artists: Array(51).fill("a") })).toBe(false);
  });
  it("counts code points", () => {
    expect(ok(trackSchema, { ...trackOnly, title: "🙂".repeat(500) })).toBe(true);
    expect(ok(trackSchema, { ...trackOnly, title: "🙂".repeat(501) })).toBe(false);
  });
  it.each([1, 86_400_000])("accepts duration %i", (d) => expect(ok(trackSchema, { ...trackOnly, durationMs: d })).toBe(true));
  it.each([0, -1, 1.5, NaN, Infinity, 86_400_001])("rejects duration %s", (d) => expect(ok(trackSchema, { ...trackOnly, durationMs: d })).toBe(false));

  it.each(["a".repeat(21), "a".repeat(23), "a".repeat(21) + "-", "a".repeat(21) + "_", "a".repeat(21) + "\n", ""])(
    "rejects Spotify ID %j", (s) => expect(ok(trackSchema, { ...trackOnly, spotifyId: s, spotifyUrl: `https://open.spotify.com/track/${s}` })).toBe(false));
  it("preserves ID case", () => {
    const s = "aBcDeFgHiJkLmNoPqRsTuV";
    const t = { ...trackOnly, spotifyId: s, spotifyUrl: `https://open.spotify.com/track/${s}` };
    expect(trackSchema.parse(t)).toEqual(t);
    expect(ok(trackSchema, { ...t, spotifyUrl: `https://open.spotify.com/track/${s.toLowerCase()}` })).toBe(false);
  });
  it.each([
    "https://open.spotify.com/track/" + "b".repeat(22),
    "http://open.spotify.com/track/" + trackOnly.spotifyId,
    "https://open.spotify.com/track/" + trackOnly.spotifyId + "?si=abc",
    "https://open.spotify.com/intl-de/track/" + trackOnly.spotifyId,
    "https://open.spotify.com.example.com/track/" + trackOnly.spotifyId,
    "https://open.spotify.com/track/" + trackOnly.spotifyId + "/",
    " https://open.spotify.com/track/" + trackOnly.spotifyId,
  ])("rejects spotifyUrl %s", (u) => expect(ok(trackSchema, { ...trackOnly, spotifyUrl: u })).toBe(false));

  it.each(["http://example.com/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "/covers/a.jpg", "HTTPS://example.com/a.jpg", "https://", "https://example.com/a b", ""])(
    "rejects cover %j", (u) => expect(ok(trackSchema, { ...trackOnly, coverImageUrl: u })).toBe(false));
  it("limits cover length to 2048", () => {
    const u = (n: number) => "https://example.com/" + "a".repeat(n - 20);
    expect(ok(trackSchema, { ...trackOnly, coverImageUrl: u(2048) })).toBe(true);
    expect(ok(trackSchema, { ...trackOnly, coverImageUrl: u(2049) })).toBe(false);
  });
});

describe("youtubeLinkSchema", () => {
  const video = { kind: "video", url: "https://www.youtube.com/watch?v=abcDEF-_123" };
  const search = { kind: "search", url: "https://www.youtube.com/results?search_query=Example%20Song" };
  it("accepts both kinds unchanged", () => {
    expect(youtubeLinkSchema.parse(video)).toEqual(video);
    expect(youtubeLinkSchema.parse(search)).toEqual(search);
  });
  it.each([
    "https://youtu.be/abcDEF-_123", "https://m.youtube.com/watch?v=abcDEF-_123", "https://music.youtube.com/watch?v=abcDEF-_123",
    "http://www.youtube.com/watch?v=abcDEF-_123", "javascript:alert(1)", "https://www.youtube.com/watch?v=abcDEF-_12",
    "https://www.youtube.com/watch?v=abcDEF-_1234", "https://www.youtube.com/watch?v=abcDEF-_123&t=1",
    "https://www.youtube.com/watch?v=abcDEF-_123#x", "https://www.youtube.com/watch?v=abcDEF._123",
  ])("rejects video url %s", (url) => expect(ok(youtubeLinkSchema, { kind: "video", url })).toBe(false));
  it.each([
    "https://www.youtube.com/results?search_query=", "https://www.youtube.com/results?search_query=a b",
    "https://www.youtube.com/results?search_query=a&b=1", "https://www.youtube.com/results?search_query=a#x",
    "http://www.youtube.com/results?search_query=a", "https://m.youtube.com/results?search_query=a",
    "https://music.youtube.com/results?search_query=a", "javascript:alert(1)",
  ])("rejects search url %s", (url) => expect(ok(youtubeLinkSchema, { kind: "search", url })).toBe(false));
  it("requires kind to match the URL form", () => {
    expect(ok(youtubeLinkSchema, { kind: "search", url: video.url })).toBe(false);
    expect(ok(youtubeLinkSchema, { kind: "video", url: search.url })).toBe(false);
    expect(ok(youtubeLinkSchema, { kind: "other", url: video.url })).toBe(false);
    expect(ok(youtubeLinkSchema, { url: video.url })).toBe(false);
  });
  it("rejects unknown properties, missing url and null", () => {
    expect(ok(youtubeLinkSchema, { ...video, title: "x" })).toBe(false);
    expect(ok(youtubeLinkSchema, { kind: "video" })).toBe(false);
    expect(ok(youtubeLinkSchema, { kind: "video", url: null })).toBe(false);
    expect(ok(youtubeLinkSchema, null)).toBe(false);
  });
});

describe("playlistTrackSchema", () => {
  it.each(["youtube", "matchReason"])("requires %s", (f) => {
    const m: Record<string, unknown> = clone(base);
    delete m[f];
    expect(ok(playlistTrackSchema, m)).toBe(false);
    expect(ok(playlistTrackSchema, { ...base, [f]: null })).toBe(false);
  });
  it("applies the track rules", () => {
    expect(ok(playlistTrackSchema, { ...base, spotifyUrl: "https://open.spotify.com/track/" + "b".repeat(22) })).toBe(false);
    expect(ok(playlistTrackSchema, { ...base, extra: 1 })).toBe(false);
    expect(ok(playlistTrackSchema, { ...base, youtube: { ...base.youtube, extra: 1 } })).toBe(false);
  });
  it("limits matchReason to 1-300 non-blank characters", () => {
    expect(ok(playlistTrackSchema, { ...base, matchReason: "x" })).toBe(true);
    expect(ok(playlistTrackSchema, { ...base, matchReason: "x".repeat(300) })).toBe(true);
    expect(ok(playlistTrackSchema, { ...base, matchReason: "x".repeat(301) })).toBe(false);
    for (const b of ["", "  ", "\n\t"]) expect(ok(playlistTrackSchema, { ...base, matchReason: b })).toBe(false);
    expect(ok(playlistTrackSchema, { ...base, matchReason: 5 })).toBe(false);
  });
});

describe("playlistSchema", () => {
  const make = (n: number, requestedLength: unknown, featured = id(1)) => ({ ...playlist, requestedLength, preferences: { ...playlist.preferences, length: requestedLength }, tracks: many(n), featuredTrackId: featured });
  it.each(["mood", "requestedLength", "preferences", "tracks", "featuredTrackId"])("requires %s", (f) => {
    const m: Record<string, unknown> = clone(playlist);
    delete m[f];
    expect(ok(playlistSchema, m)).toBe(false);
    expect(ok(playlistSchema, { ...playlist, [f]: null })).toBe(false);
  });
  it("rejects unknown properties at each level", () => {
    expect(ok(playlistSchema, { ...playlist, name: "x" })).toBe(false);
    expect(ok(playlistSchema, { ...playlist, mood: { ...playlist.mood, extra: 1 } })).toBe(false);
    expect(ok(playlistSchema, { ...playlist, tracks: [{ ...base, extra: 1 }] })).toBe(false);
    expect(ok(playlistSchema, { ...playlist, tracks: [{ ...base, youtube: { ...base.youtube, extra: 1 } }] })).toBe(false);
  });
  it("rejects an invalid nested mood", () => {
    expect(ok(playlistSchema, { ...playlist, mood: { ...playlist.mood, confidence: 2 } })).toBe(false);
    expect(ok(playlistSchema, { ...playlist, mood: { ...playlist.mood, primaryEmotion: "angry" } })).toBe(false);
  });
  it.each([5, 10, 20, 30])("accepts requestedLength %i", (n) => expect(ok(playlistSchema, make(1, n))).toBe(true));
  it.each([0, 15, 31, "10", null, 5.5])("rejects requestedLength %j", (n) => expect(ok(playlistSchema, make(1, n))).toBe(false));
  it("rejects empty tracks", () => expect(ok(playlistSchema, { ...playlist, tracks: [] })).toBe(false));
  it("limits tracks to requestedLength", () => {
    expect(ok(playlistSchema, make(30, 30))).toBe(true);
    expect(ok(playlistSchema, make(31, 30))).toBe(false);
    expect(ok(playlistSchema, make(6, 5))).toBe(false);
    expect(ok(playlistSchema, make(2, 30))).toBe(true);
  });
  it("rejects duplicate spotifyId", () => {
    expect(ok(playlistSchema, { ...playlist, tracks: [withId(1), withId(1)], featuredTrackId: id(1) })).toBe(false);
  });
  it("requires the featured track to be listed, anywhere in the list", () => {
    expect(ok(playlistSchema, make(3, 5, id(9)))).toBe(false);
    expect(ok(playlistSchema, make(3, 5, id(3)))).toBe(true);
    expect(ok(playlistSchema, make(3, 5, ""))).toBe(false);
  });
  it("rejects an invalid nested track", () => {
    expect(ok(playlistSchema, { ...playlist, tracks: [{ ...base, durationMs: 0 }] })).toBe(false);
  });
});

describe("playlist preferences", () => {
  const firstIssuePath = (v: unknown) => {
    const r = playlistSchema.safeParse(v);
    return r.success ? null : r.error.issues.map((i) => i.path);
  };
  const withPrefs = (preferences: unknown) => ({ ...playlist, preferences });
  const prefs = playlist.preferences;
  it("accepts default preferences", () => {
    expect(ok(playlistSchema, withPrefs({ ...DEFAULT_PREFERENCES, length: playlist.requestedLength }))).toBe(true);
  });
  it("rejects a missing or null preferences value", () => {
    expect(firstIssuePath({ ...playlist, preferences: undefined })).not.toBeNull();
    expect(ok(playlistSchema, withPrefs(null))).toBe(false);
  });
  it.each([
    ["unknown genre", { ...prefs, genres: ["polka"] }],
    ["duplicate genre", { ...prefs, genres: ["jazz", "jazz"] }],
    ["too many artists", { ...prefs, artists: Array.from({ length: 11 }, (_, i) => `Artist ${i}`) }],
    ["blank artist", { ...prefs, artists: ["  "] }],
    ["unknown situation", { ...prefs, situation: "skiing" }],
    ["length 7", { ...prefs, length: 7 }],
    ["extra key", { ...prefs, mood: "x" }],
  ])("rejects invalid preferences: %s", (_name, bad) => {
    const paths = firstIssuePath(withPrefs(bad));
    expect(paths).not.toBeNull();
    for (const p of paths!) expect(p[0]).toBe("preferences");
  });
  it("requires preferences.length to equal requestedLength", () => {
    const bad = { ...playlist, requestedLength: 10, preferences: { ...prefs, length: 20 } };
    expect(firstIssuePath(bad)).toContainEqual(["preferences", "length"]);
    for (const n of PLAYLIST_LENGTHS) {
      expect(ok(playlistSchema, { ...playlist, requestedLength: n, preferences: { ...prefs, length: n } })).toBe(true);
    }
  });
  it("keeps PLAYLIST_LENGTHS and PREFERENCE_LENGTHS equal", () => {
    expect([...PLAYLIST_LENGTHS]).toEqual([...PREFERENCE_LENGTHS]);
  });
});

describe("playlistJsonSchema", () => {
  type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const js = playlistJsonSchema as J;
  const trackJs = js.properties.tracks.items as J;
  it("is serializable draft 2020-12 from the Zod source", () => {
    expect(js).toEqual(z.toJSONSchema(playlistSchema));
    expect(JSON.parse(JSON.stringify(js))).toEqual(js);
    expect(js.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });
  it("requires fields and forbids extras on each object", () => {
    expect(js.required).toEqual(["mood", "requestedLength", "preferences", "tracks", "featuredTrackId"]);
    expect(js.additionalProperties).toBe(false);
    expect(trackJs.additionalProperties).toBe(false);
    expect(trackJs.required).toEqual([
      "spotifyId", "spotifyUrl", "title", "artists", "album", "durationMs", "coverImageUrl", "youtube", "matchReason",
    ]);
    const kinds = trackJs.properties.youtube.oneOf as J[];
    expect(kinds.map((k) => k.properties.kind.const)).toEqual(["video", "search"]);
    for (const k of kinds) {
      expect(k.additionalProperties).toBe(false);
      expect(k.required).toEqual(["kind", "url"]);
    }
    expect(JSON.stringify(js)).not.toContain('"default"');
  });
  it("keeps lengths, patterns and bounds", () => {
    expect(js.properties.requestedLength.enum).toEqual([5, 10, 20, 30]);
    expect(js.properties.tracks.minItems).toBe(1);
    expect(js.properties.tracks.maxItems).toBeUndefined();
    const p = trackJs.properties;
    expect(p.spotifyId.pattern).toBe("^[0-9A-Za-z]{22}$");
    expect(new RegExp(p.spotifyUrl.pattern).test("https://open.spotify.com/track/" + "a".repeat(22))).toBe(true);
    expect(new RegExp(p.spotifyUrl.pattern).test("https://open.spotify.com/track/a?si=1")).toBe(false);
    expect(p.title).toMatchObject({ minLength: 1, maxLength: 500, pattern: "\\S" });
    expect(p.artists).toMatchObject({ minItems: 1, maxItems: 50, items: { minLength: 1, maxLength: 200, pattern: "\\S" } });
    expect(p.album.anyOf).toEqual([{ type: "string", minLength: 1, maxLength: 500, pattern: "\\S" }, { type: "null" }]);
    expect(p.durationMs).toEqual({ type: "integer", minimum: 1, maximum: 86_400_000 });
    const cover = p.coverImageUrl.anyOf[0];
    expect(cover.maxLength).toBe(2048);
    expect(new RegExp(cover.pattern).test("https://example.com/a.jpg")).toBe(true);
    expect(new RegExp(cover.pattern).test("http://example.com/a.jpg")).toBe(false);
    expect(p.matchReason).toMatchObject({ minLength: 1, maxLength: 300, pattern: "\\S" });
    const [video, search] = p.youtube.oneOf as J[];
    expect(new RegExp(video.properties.url.pattern).test("https://www.youtube.com/watch?v=abcDEF-_123")).toBe(true);
    expect(new RegExp(video.properties.url.pattern).test("https://youtu.be/abcDEF-_123")).toBe(false);
    expect(new RegExp(search.properties.url.pattern).test("https://www.youtube.com/results?search_query=a%20b")).toBe(true);
    expect(new RegExp(search.properties.url.pattern).test("https://www.youtube.com/results?search_query=a&b")).toBe(false);
  });
  it("describes the preferences fields", () => {
    const pr = js.properties.preferences as J;
    expect(pr.additionalProperties).toBe(false);
    expect(pr.required).toEqual(["genres", "artists", "languages", "situation", "length"]);
    expect(Object.keys(pr.properties)).toEqual(["genres", "artists", "languages", "situation", "length"]);
  });
  it("keeps the mood constraints from the mood contract", () => {
    expect(js.properties.mood.additionalProperties).toBe(false);
    expect(js.properties.mood.properties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(js.properties.mood.properties.secondaryMoods.maxItems).toBe(3);
  });
});
