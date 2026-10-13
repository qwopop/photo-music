import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildSearchCriteria } from "../criteria";
import type { MoodResult } from "../mood";
import { playlistSchema, playlistTrackSchema, youtubeLinkSchema } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import type { Preferences } from "../preferences";
import { fakeTrack, RecordingSearch, RecordingVideos } from "./fakes";
import { recommendPlaylist, RecommendError } from "./index";

const mood: MoodResult = {
  primaryEmotion: "calm",
  secondaryMoods: ["dreamy"],
  explanation: "The colors and stillness may suggest a calm scene.",
  confidence: 0.8,
};

const preferences = (overrides: Partial<Preferences> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  ...overrides,
});

function deps(search: RecordingSearch, videos = new RecordingVideos()) {
  return { search, videos };
}

async function recommend(
  search: RecordingSearch,
  options: Preferences = DEFAULT_PREFERENCES,
  videos = new RecordingVideos(),
) {
  return recommendPlaylist(mood, options, deps(search, videos));
}

function errorCode(error: unknown) {
  return error instanceof RecommendError ? error.code : undefined;
}

describe("recommendPlaylist contracts and queries", () => {
  it("returns a playlist accepted by the shared schema with the input preferences", async () => {
    const prefs = preferences({ length: 5, languages: ["french"] });
    const playlist = await recommend(new RecordingSearch(() => [fakeTrack(1)]), prefs);

    expect(playlistSchema.parse(playlist)).toEqual(playlist);
    expect(playlist.preferences).toEqual(prefs);
    expect(playlist.requestedLength).toBe(prefs.length);
  });

  it("plans the exact default genre queries using the first two criteria keywords", async () => {
    const search = new RecordingSearch(() => [fakeTrack(1)]);
    await recommend(search);
    const criteria = buildSearchCriteria(mood, DEFAULT_PREFERENCES);
    expect(search.queries).toEqual(criteria.genres.slice(0, 3).map(({ genre }) => ({
      text: criteria.keywords.slice(0, 2).join(" "),
      genre,
      languages: DEFAULT_PREFERENCES.languages,
      limit: 20,
    })));
  });

  it("caps searches at three genres and three artists and passes languages through", async () => {
    const prefs = preferences({
      genres: ["rock", "jazz", "pop", "latin"],
      artists: ["Artist One", "Artist Two", "Artist Three", "Artist Four", "Artist Five"],
      languages: ["french", "spanish"],
    });
    const search = new RecordingSearch(() => [fakeTrack(1)]);
    await recommend(search, prefs);

    const criteria = buildSearchCriteria(mood, prefs);
    expect(search.queries).toHaveLength(6);
    expect(search.queries.slice(0, 3)).toEqual(criteria.genres.slice(0, 3).map(({ genre }) => ({
      text: criteria.keywords.slice(0, 2).join(" "),
      genre,
      languages: prefs.languages,
      limit: 20,
    })));
    expect(search.queries.slice(3)).toEqual(prefs.artists.slice(0, 3).map((artist) => ({
      text: artist,
      artist,
      languages: prefs.languages,
      limit: 20,
    })));
  });

  it("does not make artist searches when no preference artists are selected", async () => {
    const search = new RecordingSearch(() => [fakeTrack(1)]);
    await recommend(search, preferences({ genres: ["rock", "jazz", "pop", "latin"], artists: [] }));
    expect(search.queries.every((query) => query.artist === undefined)).toBe(true);
    expect(search.queries).toHaveLength(3);
  });

  it("imports no vision or configuration code and reads no environment variables", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:vision|config)/);
    expect(source).not.toMatch(/process\.env/);
  });
});

describe("candidate validation and de-duplication", () => {
  it("keeps only field-for-field valid tracks returned by a provider", async () => {
    const validA = fakeTrack(1);
    const validB = fakeTrack(2);
    const junk = [
      null,
      "not a track",
      {},
      { ...fakeTrack(3), spotifyId: "bad-id" },
      { ...fakeTrack(4), title: "   " },
      { ...fakeTrack(5), spotifyUrl: "https://example.com/wrong" },
    ];
    const playlist = await recommend(new RecordingSearch(() => [null, ...junk, validA, validB]));

    expect(playlist.tracks.map(({ spotifyId }) => spotifyId)).toEqual([validA.spotifyId, validB.spotifyId]);
    for (const [actual, expected] of [[playlist.tracks[0], validA], [playlist.tracks[1], validB]] as const) {
      expect(Object.keys(actual).sort()).toEqual([...Object.keys(expected), "youtube", "matchReason"].sort());
      expect(actual).toMatchObject(expected);
    }
    for (const track of playlist.tracks) expect(playlistTrackSchema.safeParse(track).success).toBe(true);
  });

  it("keeps the earliest duplicate id and drops normalized title-and-artist re-releases", async () => {
    const earliest = fakeTrack(1, { title: "  Blue   Hour ", artists: [" The Artist "] });
    const changedDuplicate = { ...earliest, title: "Changed title" };
    const rerelease = fakeTrack(2, { title: "blue hour", artists: ["the artist"] });
    const differentArtist = fakeTrack(3, { title: "blue hour", artists: ["Another Artist"] });
    const search = new RecordingSearch((query) =>
      query.genre === buildSearchCriteria(mood, DEFAULT_PREFERENCES).genres[0].genre
        ? [earliest, changedDuplicate, rerelease, differentArtist]
        : [],
    );
    const playlist = await recommend(search);

    expect(playlist.tracks.map(({ spotifyId }) => spotifyId)).toEqual([earliest.spotifyId, differentArtist.spotifyId]);
    expect(playlist.tracks[0]).toMatchObject(earliest);
  });

  it("returns NO_TRACKS when successful searches contain no valid candidates", async () => {
    await expect(recommend(new RecordingSearch(() => [null, {}, "junk"]))).rejects.toMatchObject({
      code: "NO_TRACKS",
    });
  });
});

describe("ranking, variety, length, and reasons", () => {
  it("ranks by combined query weights and artist preference bonus deterministically", async () => {
    const prefs = preferences({ length: 5, artists: ["Chosen Artist", "Second Artist", "Third Artist"] });
    const criteria = buildSearchCriteria(mood, prefs);
    const combined = fakeTrack(2);
    const single = fakeTrack(3);
    const preferenceMatch = fakeTrack(1, { artists: ["chosen artist"] });
    const artistOnly = fakeTrack(4);
    const search = new RecordingSearch((query) => {
      if (query.genre === criteria.genres[0].genre) return [combined, single];
      if (query.genre === criteria.genres[1].genre) return [combined];
      if (query.artist === "Chosen Artist") return [preferenceMatch];
      if (query.artist === "Second Artist") return [artistOnly];
      return [];
    });

    const first = await recommend(search, prefs);
    const second = await recommend(new RecordingSearch((query) => {
      if (query.genre === criteria.genres[0].genre) return [combined, single];
      if (query.genre === criteria.genres[1].genre) return [combined];
      if (query.artist === "Chosen Artist") return [preferenceMatch];
      if (query.artist === "Second Artist") return [artistOnly];
      return [];
    }), prefs);

    expect(first.tracks.map(({ spotifyId }) => spotifyId)).toEqual([
      preferenceMatch.spotifyId,
      combined.spotifyId,
      single.spotifyId,
      artistOnly.spotifyId,
    ]);
    expect(second.tracks.map(({ spotifyId }) => spotifyId)).toEqual(first.tracks.map(({ spotifyId }) => spotifyId));
    expect(first.featuredTrackId).toBe(preferenceMatch.spotifyId);
    expect(first.tracks[0].spotifyId).toBe(first.featuredTrackId);
  });

  it("limits a first artist to two tracks and restores skipped tracks only when needed", async () => {
    const tracks = [
      fakeTrack(1, { artists: ["Same Artist"] }),
      fakeTrack(2, { artists: ["Same Artist"] }),
      fakeTrack(3, { artists: ["Same Artist"] }),
      fakeTrack(4, { artists: ["Other Artist"] }),
      fakeTrack(5, { artists: ["Third Artist"] }),
      fakeTrack(6, { artists: ["Fourth Artist"] }),
    ];
    const full = await recommend(new RecordingSearch(() => tracks), preferences({ length: 5 }));
    expect(full.tracks.map(({ spotifyId }) => spotifyId)).toEqual([
      tracks[0].spotifyId,
      tracks[1].spotifyId,
      tracks[3].spotifyId,
      tracks[4].spotifyId,
      tracks[5].spotifyId,
    ]);

    const short = await recommend(
      new RecordingSearch(() => tracks.slice(0, 3)),
      preferences({ length: 5 }),
    );
    expect(short.tracks.map(({ spotifyId }) => spotifyId)).toEqual(tracks.slice(0, 3).map(({ spotifyId }) => spotifyId));
  });

  it.each([5, 10, 20, 30])("returns requested length %i when enough tracks exist", async (length: number) => {
    const tracks = Array.from({ length: 50 }, (_, index) => fakeTrack(index + 1));
    const playlist = await recommend(new RecordingSearch(() => tracks), preferences({ length: length as Preferences["length"] }));
    expect(playlist.tracks).toHaveLength(length);
    expect(new Set(playlist.tracks.map(({ spotifyId }) => spotifyId)).size).toBe(length);
    expect(playlist.featuredTrackId).toBe(playlist.tracks[0].spotifyId);
  });

  it.each([5, 10, 20, 30])("returns three tracks, without padding, for requested length %i", async (length: number) => {
    const tracks = [fakeTrack(1), fakeTrack(2), fakeTrack(3)];
    const playlist = await recommend(new RecordingSearch(() => tracks), preferences({ length: length as Preferences["length"] }));
    expect(playlist.tracks.map(({ spotifyId }) => spotifyId)).toEqual(tracks.map(({ spotifyId }) => spotifyId));
  });

  it("gives each track a short tentative reason based on its search sources and primary emotion", async () => {
    const prefs = preferences({ artists: ["Chosen Artist"] });
    const genre = buildSearchCriteria(mood, prefs).genres[0].genre;
    const genreTrack = fakeTrack(1);
    const artistTrack = fakeTrack(2);
    const severalTrack = fakeTrack(3);
    const search = new RecordingSearch((query) => {
      if (query.genre === genre) return [genreTrack, severalTrack];
      if (query.artist === "Chosen Artist") return [artistTrack, severalTrack];
      return [];
    });
    const playlist = await recommend(search, prefs);
    const byId = new Map(playlist.tracks.map((track) => [track.spotifyId, track]));

    expect(byId.get(genreTrack.spotifyId)?.matchReason).toContain(genre);
    expect(byId.get(artistTrack.spotifyId)?.matchReason).toContain("Chosen Artist");
    expect(byId.get(severalTrack.spotifyId)?.matchReason).toContain(genre);
    expect(byId.get(severalTrack.spotifyId)?.matchReason).toContain("Chosen Artist");
    for (const track of playlist.tracks) {
      expect(track.matchReason).toContain(mood.primaryEmotion);
      expect(track.matchReason.length).toBeGreaterThanOrEqual(1);
      expect(track.matchReason.length).toBeLessThanOrEqual(300);
      expect(track.matchReason.toLowerCase()).toContain("may suit");
    }
  });
});

describe("YouTube resolution", () => {
  it("resolves only chosen tracks and validates provider links", async () => {
    const first = fakeTrack(1);
    const second = fakeTrack(2);
    const search = new RecordingSearch(() => [first, second, null, {}]);
    const videos = new RecordingVideos((track) => ({
      kind: "video",
      url: `https://www.youtube.com/watch?v=${track.spotifyId.slice(-11)}`,
    }));
    const playlist = await recommend(search, preferences({ length: 5 }), videos);

    expect(videos.tracks.map(({ spotifyId }) => spotifyId)).toEqual([first.spotifyId, second.spotifyId]);
    for (const track of playlist.tracks) expect(youtubeLinkSchema.safeParse(track.youtube).success).toBe(true);
  });

  it("uses a search link when the video resolver throws or returns invalid data", async () => {
    const track = fakeTrack(1, { title: "A & # Song" });
    for (const answer of [
      () => {
        throw new Error("sensitive provider details");
      },
      () => ({ kind: "video", url: "not-a-youtube-link" }),
    ]) {
      const playlist = await recommend(new RecordingSearch(() => [track]), DEFAULT_PREFERENCES, new RecordingVideos(answer));
      const youtube = playlist.tracks[0].youtube;
      expect(youtubeLinkSchema.parse(youtube)).toEqual(youtube);
      expect(youtube.kind).toBe("search");
      if (youtube.kind === "search") {
        expect(youtube.url).toBe(
          `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.title} ${track.artists[0]}`)}`,
        );
      }
    }
  });

  it("uses a search link when the video resolver does not return within five seconds", async () => {
    vi.useFakeTimers();
    try {
      const track = fakeTrack(1);
      const pending = recommend(
        new RecordingSearch(() => [track]),
        DEFAULT_PREFERENCES,
        new RecordingVideos(() => new Promise<unknown>(() => {})),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const playlist = await pending;
      expect(playlist.tracks[0].youtube).toEqual({
        kind: "search",
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.title} ${track.artists[0]}`)}`,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("search failures", () => {
  it("builds a playlist from successful searches when others throw", async () => {
    const criteria = buildSearchCriteria(mood, DEFAULT_PREFERENCES);
    const track = fakeTrack(1);
    const search = new RecordingSearch((query) => {
      if (query.genre === criteria.genres[0].genre) throw new Error("provider secret");
      if (query.genre === criteria.genres[1].genre) return [track];
      throw new Error("another provider secret");
    });
    const playlist = await recommend(search);
    expect(playlist.tracks.map(({ spotifyId }) => spotifyId)).toEqual([track.spotifyId]);
  });

  it("returns a fixed safe SEARCH_UNAVAILABLE error when every search throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await recommend(new RecordingSearch(() => {
        throw new Error("provider secret and query text");
      })).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(RecommendError);
      expect(errorCode(error)).toBe("SEARCH_UNAVAILABLE");
      expect((error as Error).message).toBe("Music search is unavailable right now. Please try again later.");
      expect((error as Error).message).not.toContain("provider secret");
      expect("cause" in (error as object)).toBe(false);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("counts searches that do not return within ten seconds as failures", async () => {
    vi.useFakeTimers();
    try {
      const pending = recommend(new RecordingSearch(() => new Promise<unknown[]>(() => {})));
      const assertion = expect(pending).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
