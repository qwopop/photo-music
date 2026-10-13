import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { youtubeLinkSchema, type Track } from "../playlist";
import {
  createYouTubeResolver,
  MAX_CACHE_ENTRIES,
  NO_RESULT_CACHE_TTL_MS,
  QUOTA_PAUSE_MS,
  VIDEO_CACHE_TTL_MS,
  youTubeSearchLink,
  type VideoLinkResolver,
} from "./index";

const KEY = "SECRET-KEY-123";
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

function track(title = "Blinding Lights", artist = "The Weeknd", n = 1): Track {
  const spotifyId = `TrackId${String(n).padStart(15, "0")}`;
  return {
    spotifyId,
    spotifyUrl: `https://open.spotify.com/track/${spotifyId}`,
    title,
    artists: [artist, "Second Artist"],
    album: null,
    durationMs: 200_000,
    coverImageUrl: null,
  };
}

type Responder = () => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, reason: string) =>
  json({ error: { code: status, message: `secret provider text ${KEY}`, errors: [{ reason }] } }, status);

let clock = 0;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
let globalFetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clock = 1_000_000;
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  globalFetchMock = vi.fn(() => {
    throw new Error("Unexpected global fetch");
  });
  vi.stubGlobal("fetch", globalFetchMock);
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  expect(globalFetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function make(responder: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => responder(String(input)));
  const resolver = createYouTubeResolver({
    apiKey: KEY,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock,
  });
  return { resolver, fetchMock };
}

const expectSearchLink = (link: unknown, t = track()) => {
  expect(link).toEqual(youTubeSearchLink(t.title, t.artists[0]));
  expect(youtubeLinkSchema.safeParse(link).success).toBe(true);
  expect(JSON.stringify(link)).not.toContain(KEY);
};

describe("request", () => {
  it("does not search when the API key is empty or whitespace", async () => {
    const fetchMock = vi.fn();
    const resolver = createYouTubeResolver({
      apiKey: " \t\n",
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock,
    });

    expectSearchLink(await resolver.resolve(track()));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends exactly one GET with the documented parameters", async () => {
    const { resolver, fetchMock } = make(() => json(fixture("clear-match")));
    await resolver.resolve(track());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=5" +
        "&q=Blinding+Lights+The+Weeknd&fields=items%28id%2FvideoId%2Csnippet%28title%2CchannelTitle%29%29" +
        `&key=${KEY}`,
    );
  });

  it("encodes special characters so they decode back to the same q, using the first artist only", async () => {
    const { resolver, fetchMock } = make(() => json({ items: [] }));
    await resolver.resolve(track("A&B #1 + 夜に駆ける", "Артист"));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("A&B #1 + 夜に駆ける Артист");
    expect(url.searchParams.get("key")).toBe(KEY);
  });

  it("treats a request that never answers as a failure after 4 s", async () => {
    vi.useFakeTimers();
    const { resolver, fetchMock } = make(() => new Promise<Response>(() => {}));
    const pending = resolver.resolve(track());
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expectSearchLink(await pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const again = resolver.resolve(track()); // errors are not cached
    await vi.advanceTimersByTimeAsync(4_000);
    await again;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("choosing the video", () => {
  const watch = (id: string) => ({ kind: "video", url: `https://www.youtube.com/watch?v=${id}` });

  it("picks the artist's result over an earlier acceptable one", async () => {
    const { resolver } = make(() => json(fixture("clear-match")));
    expect(await resolver.resolve(track())).toEqual(watch("bbbbbbbbbbb"));
  });

  it("picks the artist's channel when only it matches", async () => {
    const { resolver } = make(() => json(fixture("artist-channel")));
    expect(await resolver.resolve(track())).toEqual(watch("ddddddddddd"));
  });

  it("falls back to the first acceptable result when no artist matches", async () => {
    const { resolver } = make(() => json(fixture("clear-match")));
    expect(await resolver.resolve(track("Blinding Lights", "Nobody"))).toEqual(watch("aaaaaaaaaaa"));
  });

  it("matches titles ignoring case and repeated spaces", async () => {
    const { resolver } = make(() => json(fixture("artist-channel")));
    expect(await resolver.resolve(track("  blinding   LIGHTS ", "x"))).toEqual(watch("ccccccccccc"));
  });

  it.each(["no-title-match", "empty", "no-video-id", "bad-video-id-length"])(
    "returns the search link for fixture %s",
    async (name) => {
      const { resolver } = make(() => json(fixture(name)));
      expectSearchLink(await resolver.resolve(track()));
    },
  );
});

describe("youTubeSearchLink", () => {
  it("encodes the title and artist", () => {
    const link = youTubeSearchLink("A&B #1", "Some Artist");
    expect(link).toEqual({
      kind: "search",
      url: "https://www.youtube.com/results?search_query=" + encodeURIComponent("A&B #1 Some Artist"),
    });
    expect(youtubeLinkSchema.safeParse(link).success).toBe(true);
  });

  it("cuts very long text on a character boundary", () => {
    const link = youTubeSearchLink("é😀".repeat(250), "😀".repeat(200));
    expect(youtubeLinkSchema.safeParse(link).success).toBe(true);
    const decoded = decodeURIComponent(link.url.split("=")[1]);
    expect(Array.from(decoded).length).toBe(500 + 1 + 200);
  });
});

describe("failures return the search link and never throw", () => {
  const cases: Array<[string, Responder]> = [
    ["403 quotaExceeded", () => apiError(403, "quotaExceeded")],
    ["403 dailyLimitExceeded", () => apiError(403, "dailyLimitExceeded")],
    ["400 keyInvalid", () => apiError(400, "keyInvalid")],
    ["429", () => apiError(429, "rateLimitExceeded")],
    ["500", () => new Response("boom", { status: 500 })],
    ["network error", () => Promise.reject(new TypeError(`failed ${KEY}`))],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["null", () => json(null)],
    ["array", () => json([])],
    ["items not an array", () => json({ items: "x" })],
  ];
  it.each(cases)("%s", async (_name, responder) => {
    const { resolver } = make(responder);
    expectSearchLink(await resolver.resolve(track()));
  });
});

describe("cache", () => {
  it("serves a found video from cache for 7 days, with equivalent keys", async () => {
    const { resolver, fetchMock } = make(() => json(fixture("clear-match")));
    const first = await resolver.resolve(track("Blinding Lights", "THE WEEKND"));
    clock += VIDEO_CACHE_TTL_MS - 1;
    expect(await resolver.resolve(track(" blinding  lights ", "the weeknd "))).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1;
    await resolver.resolve(track("Blinding Lights", "THE WEEKND"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a no-result answer for 1 hour", async () => {
    const { resolver, fetchMock } = make(() => json({ items: [] }));
    await resolver.resolve(track());
    clock += NO_RESULT_CACHE_TTL_MS - 1;
    await resolver.resolve(track());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1;
    await resolver.resolve(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  const errors: Array<[string, Responder]> = [
    ["500", () => new Response("x", { status: 500 })],
    ["429", () => apiError(429, "rateLimitExceeded")],
    ["bad JSON", () => new Response("nope")],
    ["keyInvalid", () => apiError(400, "keyInvalid")],
    ["network", () => Promise.reject(new Error("down"))],
  ];
  it.each(errors)("does not cache an error (%s)", async (_n, responder) => {
    const { resolver, fetchMock } = make(responder);
    await resolver.resolve(track());
    await resolver.resolve(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one request between simultaneous calls for the same key", async () => {
    const { resolver, fetchMock } = make(() => json(fixture("clear-match")));
    const [a, b] = await Promise.all([
      resolver.resolve(track()),
      resolver.resolve(track(" blinding lights", "THE WEEKND")),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("holds at most 1000 entries, dropping the oldest first", async () => {
    const { resolver, fetchMock } = make(() =>
      json({ items: [{ id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Song", channelTitle: "c" } }] }),
    );
    for (let i = 0; i <= MAX_CACHE_ENTRIES; i++) await resolver.resolve(track(`Song ${i}`, "A", i));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 1);
    await resolver.resolve(track("Song 1000", "A", 1000));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 1);
    await resolver.resolve(track("Song 0", "A", 0));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 2);
  });

  it("does not share a cache between resolvers", async () => {
    const a = make(() => json(fixture("clear-match")));
    const b = make(() => json(fixture("clear-match")));
    await a.resolver.resolve(track());
    await b.resolver.resolve(track());
    expect(a.fetchMock).toHaveBeenCalledTimes(1);
    expect(b.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("quota protection", () => {
  it.each(["quotaExceeded", "dailyLimitExceeded"])("pauses for an hour after %s", async (reason) => {
    const { resolver, fetchMock } = make(() => apiError(403, reason));
    await resolver.resolve(track("One"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += QUOTA_PAUSE_MS - 1;
    expectSearchLink(await resolver.resolve(track("Two")), track("Two"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1;
    await resolver.resolve(track("Two"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still serves cached videos during the pause", async () => {
    let quota = false;
    const { resolver, fetchMock } = make(() =>
      quota ? apiError(403, "quotaExceeded") : json(fixture("clear-match")),
    );
    const cached = await resolver.resolve(track());
    quota = true;
    await resolver.resolve(track("Other", "Y"));
    expect(await resolver.resolve(track())).toEqual(cached);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  const noPause: Array<[string, Responder]> = [
    ["keyInvalid", () => apiError(400, "keyInvalid")],
    ["429", () => apiError(429, "rateLimitExceeded")],
  ];
  it.each(noPause)("does not pause after %s", async (_n, responder) => {
    const { resolver, fetchMock } = make(responder);
    await resolver.resolve(track("One"));
    await resolver.resolve(track("Two"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows at most 3 requests at once", async () => {
    let running = 0;
    let max = 0;
    const { resolver, fetchMock } = make(async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return json({ items: [] });
    });
    const links = await Promise.all(
      Array.from({ length: 10 }, (_, i) => resolver.resolve(track(`Song ${i}`, "A", i))),
    );
    expect(links).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(max).toBe(3);
  });

  it("makes no request for tracks queued behind a quota error", async () => {
    let first = true;
    const { resolver, fetchMock } = make(async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (first) {
        first = false;
        return apiError(403, "quotaExceeded");
      }
      return json({ items: [] });
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => resolver.resolve(track(`Song ${i}`, "A", i))));
    expect(fetchMock.mock.calls.length).toBeLessThan(6);
  });
});

describe("no leaks", () => {
  it("never puts the key or provider text in a link or the console", async () => {
    const responders: Responder[] = [() => apiError(403, "quotaExceeded"), () => Promise.reject(new Error(KEY))];
    for (const responder of responders) {
      const { resolver } = make(responder);
      const link = await resolver.resolve(track());
      expect(JSON.stringify(link)).not.toMatch(/SECRET|provider text/);
    }
  });
});

describe("interface fit", () => {
  it("is assignable to VideoLinkResolver", () => {
    const resolver = createYouTubeResolver({ apiKey: KEY });
    const asInterface: VideoLinkResolver = resolver;
    expectTypeOf(asInterface.resolve).parameter(0).toEqualTypeOf<Track>();
  });
});
