import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES } from "../mood";
import { playlistSchema } from "../playlist";
import type { Track } from "../playlist";
import { DEFAULT_PREFERENCES } from "../preferences";
import type { Preferences } from "../preferences";
import { fakeTrack, RecordingSearch, RecordingVideos } from "./fakes";
import { recommendPlaylist, RecommendError } from "./index";

const calm = MOOD_EXAMPLES[2]; // genres ambient, classical, jazz (weight 0.25 each), keywords calm, peaceful
const prefs = (extra: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...extra });
const tracks = (from: number, count: number) => Array.from({ length: count }, (_, i) => fakeTrack(from + i));

afterEach(() => vi.useRealTimers());

describe("queries", () => {
  const run = async (p: Preferences) => {
    const search = new RecordingSearch(() => tracks(1, 3));
    await recommendPlaylist(calm, p, { search, videos: new RecordingVideos() });
    return search.queries;
  };

  it("default preferences: three genre queries", async () => {
    expect(await run(prefs())).toEqual([
      { text: "calm peaceful", genre: "ambient", languages: [], limit: 20 },
      { text: "calm peaceful", genre: "classical", languages: [], limit: 20 },
      { text: "calm peaceful", genre: "jazz", languages: [], limit: 20 },
    ]);
  });

  it("caps at 3 genres and 3 artists and passes languages", async () => {
    const queries = await run(
      prefs({ genres: ["pop", "rock", "indie", "folk"], artists: ["A", "B", "C", "D", "E"], languages: ["english", "french"] }),
    );
    expect(queries).toHaveLength(6);
    expect(queries.slice(3)).toEqual(
      ["A", "B", "C"].map((artist) => ({ text: artist, artist, languages: ["english", "french"], limit: 20 })),
    );
    expect(queries.slice(0, 3).every((q) => q.genre && q.limit === 20 && q.languages.length === 2)).toBe(true);
  });

  it("no artists: no artist queries", async () => {
    expect((await run(prefs({ genres: ["pop"] }))).every((q) => q.artist === undefined)).toBe(true);
  });
});

describe("candidates", () => {
  it("keeps only valid tracks, field for field", async () => {
    const good = tracks(1, 3);
    const junk = [null, "x", 5, {}, { spotifyId: "short" }, fakeTrack(9, { title: "  " }), fakeTrack(8, { spotifyUrl: "https://open.spotify.com/track/other" })];
    const search = new RecordingSearch(() => [...junk, ...good]);
    const playlist = await recommendPlaylist(calm, prefs(), { search, videos: new RecordingVideos() });
    expect(playlist.tracks.map((t) => t.spotifyId).sort()).toEqual(good.map((t) => t.spotifyId).sort());
    for (const t of playlist.tracks) {
      const { youtube, matchReason, ...rest } = t;
      expect(youtube).toBeDefined();
      expect(matchReason).toBeDefined();
      expect(rest).toEqual(good.find((g) => g.spotifyId === t.spotifyId));
    }
  });

  it("drops duplicate ids and re-releases, keeping the earliest", async () => {
    const a = fakeTrack(1, { title: "Song", artists: ["Band"] });
    const rerelease = fakeTrack(2, { title: "  SONG ", artists: ["band", "Other"] });
    const same = fakeTrack(1, { title: "Different" });
    const other = fakeTrack(3);
    const search = new RecordingSearch(() => [a, rerelease, same, other]);
    const playlist = await recommendPlaylist(calm, prefs(), { search, videos: new RecordingVideos() });
    expect(playlist.tracks.map((t) => t.spotifyId)).toEqual([a.spotifyId, other.spotifyId]);
  });
});

describe("ranking", () => {
  it("orders by hand-calculated score", async () => {
    const A = fakeTrack(1);
    const B = fakeTrack(2, { artists: ["aria"] });
    const C = fakeTrack(3);
    const D = fakeTrack(4);
    // ambient 0.25, classical 0.25, jazz 0.25, one artist query 0.3
    const search = new RecordingSearch((q) => {
      if (q.genre === "ambient") return [C, A];
      if (q.genre === "classical") return [A];
      if (q.genre === "jazz") return [B];
      return [D, B];
    });
    const p = prefs({ artists: ["Aria"] });
    const run = () => recommendPlaylist(calm, p, { search, videos: new RecordingVideos() });
    const first = await run();
    // B 0.25+0.3+1=1.55, A 0.5, D 0.3, C 0.25
    expect(first.tracks.map((t) => t.spotifyId)).toEqual([B, A, D, C].map((t) => t.spotifyId));
    expect(first.featuredTrackId).toBe(B.spotifyId);
    expect(await run()).toEqual(first);
  });

  it("breaks ties by query, position, then id", async () => {
    const [x, y, z] = tracks(1, 3);
    const search = new RecordingSearch((q) => (q.genre === "ambient" ? [z, x] : q.genre === "classical" ? [y] : []));
    const playlist = await recommendPlaylist(calm, prefs(), { search, videos: new RecordingVideos() });
    expect(playlist.tracks.map((t) => t.spotifyId)).toEqual([z, x, y].map((t) => t.spotifyId));
  });
});

describe("variety and length", () => {
  it("allows at most 2 per artist when enough others exist", async () => {
    const same = Array.from({ length: 5 }, (_, i) => fakeTrack(i + 1, { artists: ["Same"] }));
    const others = tracks(10, 3);
    const search = new RecordingSearch(() => [...same, ...others]);
    const playlist = await recommendPlaylist(calm, prefs({ length: 5 }), { search, videos: new RecordingVideos() });
    expect(playlist.tracks.filter((t) => t.artists[0] === "Same")).toHaveLength(2);
    expect(playlist.tracks).toHaveLength(5);
  });

  it("adds skipped tracks back in rank order when short", async () => {
    const same = Array.from({ length: 5 }, (_, i) => fakeTrack(i + 1, { artists: ["Same"] }));
    const search = new RecordingSearch(() => same);
    const playlist = await recommendPlaylist(calm, prefs({ length: 5 }), { search, videos: new RecordingVideos() });
    expect(playlist.tracks.map((t) => t.spotifyId)).toEqual(same.map((t) => t.spotifyId));
  });

  it.each([5, 10, 20, 30] as const)("returns %i of 50", async (length) => {
    const search = new RecordingSearch(() => tracks(1, 50));
    const videos = new RecordingVideos();
    const playlist = await recommendPlaylist(calm, prefs({ length }), { search, videos });
    expect(playlist.tracks).toHaveLength(length);
    expect(playlist.requestedLength).toBe(length);
    expect(playlist.featuredTrackId).toBe(playlist.tracks[0].spotifyId);
    expect(videos.resolved).toHaveLength(length);
    expect(playlistSchema.safeParse(playlist).success).toBe(true);
  });

  it("never pads or repeats with only 3 candidates", async () => {
    const list = tracks(1, 3);
    const search = new RecordingSearch(() => list);
    const playlist = await recommendPlaylist(calm, prefs({ length: 30 }), { search, videos: new RecordingVideos() });
    expect(playlist.tracks.map((t) => t.spotifyId).sort()).toEqual(list.map((t) => t.spotifyId).sort());
  });
});

describe("reasons", () => {
  const reasonsFor = async (p: Preferences, answer: RecordingSearch["search"] extends never ? never : (q: { genre?: string; artist?: string }) => Track[]) => {
    const search = new RecordingSearch(answer);
    return (await recommendPlaylist(calm, p, { search, videos: new RecordingVideos() })).tracks.map((t) => t.matchReason);
  };

  it("genre query", async () => {
    const [r] = await reasonsFor(prefs(), (q) => (q.genre === "jazz" ? [fakeTrack(1)] : []));
    expect(r).toBe("May suit a calm mood. Found through a search for jazz.");
  });

  it("artist query", async () => {
    const [r] = await reasonsFor(prefs({ artists: ["Aria"] }), (q) => (q.artist ? [fakeTrack(1)] : []));
    expect(r).toBe("May suit a calm mood. Found through your chosen artist Aria.");
  });

  it("several queries", async () => {
    const [r] = await reasonsFor(prefs({ artists: ["Aria"] }), () => [fakeTrack(1)]);
    expect(r).toBe("May suit a calm mood. Found through a search for ambient, classical, jazz and your chosen artist Aria.");
  });

  it("stays within 300 characters", async () => {
    const long = "x".repeat(100);
    const [r] = await reasonsFor(prefs({ artists: [long, long + "y", long + "z"] }), () => [fakeTrack(1)]);
    expect(r.length).toBeLessThanOrEqual(300);
    expect(r).toContain("calm");
  });
});

describe("youtube links", () => {
  const one = (videos: RecordingVideos, track = fakeTrack(1)) =>
    recommendPlaylist(calm, prefs(), { search: new RecordingSearch(() => [track]), videos });

  it("uses a valid answer and resolves only chosen tracks", async () => {
    const videos = new RecordingVideos();
    const p = await recommendPlaylist(calm, prefs({ length: 5 }), { search: new RecordingSearch(() => tracks(1, 20)), videos });
    expect(videos.resolved).toHaveLength(5);
    expect(p.tracks[0].youtube.kind).toBe("video");
  });

  it.each([
    ["throws", () => { throw new Error("secret"); }],
    ["invalid", () => ({ kind: "video", url: "nope" })],
  ])("falls back when the resolver %s", async (_n, answer) => {
    const p = await one(new RecordingVideos(answer));
    expect(p.tracks[0].youtube).toEqual({
      kind: "search",
      url: "https://www.youtube.com/results?search_query=" + encodeURIComponent("Fake Song 1 Fake Artist 1"),
    });
  });

  it("falls back after 5 s", async () => {
    vi.useFakeTimers();
    const pending = one(new RecordingVideos(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).tracks[0].youtube.kind).toBe("search");
  });

  it("encodes &, # and spaces", async () => {
    const p = await one(new RecordingVideos(() => null), fakeTrack(1, { title: "Rock & Roll #1" }));
    const { youtube } = p.tracks[0];
    expect(youtube.url).toBe("https://www.youtube.com/results?search_query=" + encodeURIComponent("Rock & Roll #1 Fake Artist 1"));
    expect(playlistSchema.safeParse(p).success).toBe(true);
  });
});

describe("search failures", () => {
  const videos = () => new RecordingVideos();

  it("builds from the remaining searches", async () => {
    const search = new RecordingSearch((q) => {
      if (q.genre === "ambient") throw new Error("boom");
      return [fakeTrack(1)];
    });
    expect((await recommendPlaylist(calm, prefs(), { search, videos: videos() })).tracks).toHaveLength(1);
  });

  it("SEARCH_UNAVAILABLE when all throw, with no leaked text or console output", async () => {
    const spy = vi.spyOn(console, "error");
    const search = new RecordingSearch(() => { throw new Error("secret query"); });
    const error = await recommendPlaylist(calm, prefs(), { search, videos: videos() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecommendError);
    expect((error as RecommendError).code).toBe("SEARCH_UNAVAILABLE");
    expect((error as RecommendError).message).not.toContain("secret");
    expect((error as RecommendError).cause).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("NO_TRACKS when nothing is valid", async () => {
    const search = new RecordingSearch(() => [null, "x"]);
    await expect(recommendPlaylist(calm, prefs(), { search, videos: videos() })).rejects.toMatchObject({ code: "NO_TRACKS" });
  });

  it("treats a search that never returns as failed after 10 s", async () => {
    vi.useFakeTimers();
    const search = new RecordingSearch(() => new Promise(() => {}));
    const result = recommendPlaylist(calm, prefs(), { search, videos: videos() }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: "SEARCH_UNAVAILABLE" });
  });
});

describe("module imports", () => {
  it("does not import vision or config", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.some((i) => /vision|config/.test(i))).toBe(false);
    expect(source).not.toContain("process.env");
  });
});
