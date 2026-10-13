import { afterEach, describe, expect, it, vi } from "vitest";
import emptyFixture from "./fixtures/search-empty.json";
import mixedFixture from "./fixtures/search-mixed.json";
import tokenFixture from "./fixtures/token.json";
import {
  MAX_PAGE_SIZE,
  SpotifyError,
  createSpotifySearch,
  type SpotifyErrorCode,
  type SpotifySearchDeps,
  type TrackQuery,
  type TrackSearch,
} from "./index";

const SECRET = "fake-client-secret-XYZ";
const CLIENT_ID = "fake-client-id-ABC";
const TOKEN = tokenFixture.access_token;
const config = { clientId: CLIENT_ID, clientSecret: SECRET };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

interface Call {
  url: string;
  init: RequestInit;
}

type Responder = (call: Call, n: number) => Response | Promise<Response>;

function setup(responder: Responder, extra: SpotifySearchDeps = {}) {
  const calls: Call[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call, calls.length);
  });
  const sleep = vi.fn(async () => {});
  const search = createSpotifySearch({
    fetch: fetchFake as unknown as typeof fetch,
    getConfig: () => config,
    sleep,
    now: () => 0,
    ...extra,
  });
  return { search, calls, sleep, fetchFake };
}

const isToken = (c: Call) => c.url === "https://accounts.spotify.com/api/token";
const ok: Responder = (call) =>
  isToken(call) ? json(200, tokenFixture) : json(200, mixedFixture);
const query = (extra: Partial<TrackQuery> = {}): TrackQuery => ({
  text: "calm",
  languages: ["en"],
  limit: 5,
  ...extra,
});
const searchCalls = (calls: Call[]) => calls.filter((c) => !isToken(c));

async function code(promise: Promise<unknown>): Promise<SpotifyErrorCode> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SpotifyError);
    return (e as SpotifyError).code;
  }
  throw new Error("did not reject");
}

afterEach(() => vi.restoreAllMocks());

describe("entry point", () => {
  it("makes no request and reads no config until search", async () => {
    const getConfig = vi.fn(() => config);
    const fetchFake = vi.fn();
    createSpotifySearch({ getConfig, fetch: fetchFake as unknown as typeof fetch });
    expect(getConfig).not.toHaveBeenCalled();
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it("is assignable to TrackSearch", () => {
    const s: TrackSearch = createSpotifySearch();
    expect(typeof s.search).toBe("function");
  });
});

describe("token", () => {
  it("sends the exact token request", async () => {
    const { search, calls } = setup(ok);
    await search.search(query());
    const t = calls[0];
    expect(t.url).toBe("https://accounts.spotify.com/api/token");
    expect(t.init.method).toBe("POST");
    expect(t.init.headers).toEqual({
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(t.init.body).toBe("grant_type=client_credentials");
  });

  it("reuses the token, and expires it 60 s early", async () => {
    let clock = 0;
    const { search, calls } = setup(ok, { now: () => clock });
    await search.search(query());
    await search.search(query());
    expect(calls.filter(isToken)).toHaveLength(1);
    clock = 3600_000 - 61_000;
    await search.search(query());
    expect(calls.filter(isToken)).toHaveLength(1);
    clock = 3600_000 - 59_000;
    await search.search(query());
    expect(calls.filter(isToken)).toHaveLength(2);
  });

  it("makes one token request for concurrent searches", async () => {
    const { search, calls } = setup(ok);
    await Promise.all([search.search(query()), search.search(query())]);
    expect(calls.filter(isToken)).toHaveLength(1);
  });

  it("does not cache a failed token request", async () => {
    const { search, calls } = setup((c, n) => (n === 1 ? json(500, {}) : ok(c, n)));
    expect(await code(search.search(query()))).toBe("UNAVAILABLE");
    await search.search(query());
    expect(calls.filter(isToken)).toHaveLength(2);
  });
});

describe("search request", () => {
  async function urlFor(q: Partial<TrackQuery>) {
    const { search, calls } = setup(ok);
    await search.search(query(q));
    return new URL(searchCalls(calls)[0].url);
  }

  it("sends bearer auth and the query parameters", async () => {
    const { search, calls } = setup(ok);
    await search.search(query());
    const c = searchCalls(calls)[0];
    expect(c.init.method).toBe("GET");
    expect(c.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    const u = new URL(c.url);
    expect(u.origin + u.pathname).toBe("https://api.spotify.com/v1/search");
    expect(u.searchParams.get("type")).toBe("track");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("offset")).toBe("0");
  });

  it("builds q", async () => {
    expect((await urlFor({ text: "calm water" })).searchParams.get("q")).toBe("calm water");
    expect((await urlFor({ genre: "lo-fi" })).searchParams.get("q")).toBe('calm genre:"lo-fi"');
    expect((await urlFor({ artist: "Ada North" })).searchParams.get("q")).toBe(
      'calm artist:"Ada North"',
    );
    expect((await urlFor({ text: "  ", genre: "jazz" })).searchParams.get("q")).toBe(
      'genre:"jazz"',
    );
    const odd = await urlFor({ text: "x", artist: 'Be"yo&ncé' });
    expect(odd.searchParams.get("q")).toBe("x artist:\"Beyo&ncé\"");
    expect(odd.search).toContain("%26");
    expect(odd.search).toContain("%C3%A9");
  });

  it("accepts and ignores languages", async () => {
    const a = await urlFor({ languages: ["en"] });
    const b = await urlFor({ languages: ["kk", "ru"] });
    expect(a.search).toBe(b.search);
  });
});

describe("page size", () => {
  const page = (n: number, from = 0) => ({
    tracks: {
      items: Array.from({ length: n }, (_, i) => ({
        id: String(from + i).padStart(22, "a"),
        name: `T${from + i}`,
        artists: [{ name: "A" }],
        album: { name: "B", images: [] },
        duration_ms: 1000,
      })),
    },
  });
  const paged: Responder = (c) => {
    if (isToken(c)) return json(200, tokenFixture);
    const u = new URL(c.url);
    const offset = Number(u.searchParams.get("offset"));
    const limit = Number(u.searchParams.get("limit"));
    return json(200, page(limit, offset));
  };

  it("pages above MAX_PAGE_SIZE", async () => {
    expect(MAX_PAGE_SIZE).toBe(10);
    const { search, calls } = setup(paged);
    const out = (await search.search(query({ limit: 20 }))) as { title: string }[];
    const reqs = searchCalls(calls).map((c) => new URL(c.url).searchParams);
    expect(reqs.map((p) => [p.get("limit"), p.get("offset")])).toEqual([
      ["10", "0"],
      ["10", "10"],
    ]);
    expect(out.map((t) => t.title)).toEqual(Array.from({ length: 20 }, (_, i) => `T${i}`));
  });

  it("uses one request up to MAX_PAGE_SIZE and cuts to limit", async () => {
    const { search, calls } = setup(paged);
    expect(await search.search(query({ limit: 1 }))).toHaveLength(1);
    expect(await search.search(query({ limit: 10 }))).toHaveLength(10);
    expect(searchCalls(calls)).toHaveLength(2);
  });

  it("stops at a short page", async () => {
    const { search, calls } = setup((c) =>
      isToken(c) ? json(200, tokenFixture) : json(200, page(4)),
    );
    expect(await search.search(query({ limit: 30 }))).toHaveLength(4);
    expect(searchCalls(calls)).toHaveLength(1);
  });

  it("rejects invalid limits without a request", async () => {
    for (const limit of [0, -1, 1.5, 51, Number.NaN, "5" as unknown as number]) {
      const { search, calls } = setup(ok);
      expect(await code(search.search(query({ limit })))).toBe("INVALID_QUERY");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("mapping", () => {
  it("maps fixtures, dropping invalid items", async () => {
    const { search } = setup(ok);
    const out = await search.search(query());
    expect(out).toEqual([
      {
        spotifyId: "11dFghVXANMlKmJXsNCbNl",
        spotifyUrl: "https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl",
        title: "Calm Water",
        artists: ["Ada North", "Bo Lake"],
        album: "Still",
        durationMs: 201000,
        coverImageUrl: "https://i.scdn.co/image/fixture-large",
      },
      {
        spotifyId: "22dFghVXANMlKmJXsNCbNl",
        spotifyUrl: "https://open.spotify.com/track/22dFghVXANMlKmJXsNCbNl",
        title: "No Cover",
        artists: ["Ada North"],
        album: "Bare",
        durationMs: 180000,
        coverImageUrl: null,
      },
      {
        spotifyId: "33dFghVXANMlKmJXsNCbNl",
        spotifyUrl: "https://open.spotify.com/track/33dFghVXANMlKmJXsNCbNl",
        title: "Single",
        artists: ["Cy Moss"],
        album: null,
        durationMs: 150000,
        coverImageUrl: null,
      },
    ]);
  });

  it("returns [] for no items", async () => {
    const { search } = setup((c) => (isToken(c) ? json(200, tokenFixture) : json(200, emptyFixture)));
    expect(await search.search(query())).toEqual([]);
  });

  it("drops items with no artists or a blank name", async () => {
    const good = mixedFixture.tracks.items[0] as Record<string, unknown>;
    const items = [
      { ...good, artists: [] },
      { ...good, name: "  " },
      { ...good, artists: undefined },
      "text",
      good,
    ];
    const { search } = setup((c) =>
      isToken(c) ? json(200, tokenFixture) : json(200, { tracks: { items } }),
    );
    const out = (await search.search(query())) as { spotifyId: string }[];
    expect(out.map((t) => t.spotifyId)).toEqual(["11dFghVXANMlKmJXsNCbNl"]);
  });
});

describe("rate limit", () => {
  const limited = (retryAfter?: string): Responder => (c) =>
    isToken(c)
      ? json(200, tokenFixture)
      : json(429, {}, retryAfter === undefined ? {} : { "Retry-After": retryAfter });

  it("waits and retries once", async () => {
    const { search, sleep, calls } = setup((c, n) =>
      isToken(c) ? json(200, tokenFixture) : n === 2 ? json(429, {}, { "Retry-After": "3" }) : ok(c, n),
    );
    expect(await search.search(query())).toHaveLength(3);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(3000);
    expect(searchCalls(calls)).toHaveLength(2);
  });

  it("rejects when the retry is also 429", async () => {
    const { search, sleep } = setup(limited("2"));
    expect(await code(search.search(query()))).toBe("RATE_LIMITED");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects without waiting for a long, missing or bad Retry-After", async () => {
    for (const h of ["6", undefined, "soon", "-1", "1.5"]) {
      const { search, sleep } = setup(limited(h));
      expect(await code(search.search(query()))).toBe("RATE_LIMITED");
      expect(sleep).not.toHaveBeenCalled();
    }
  });
});

describe("auth errors", () => {
  it("retries a 401 once with a new token", async () => {
    let tokens = 0;
    const { search, calls } = setup((c) => {
      if (isToken(c)) {
        tokens += 1;
        return json(200, { ...tokenFixture, access_token: `t${tokens}` });
      }
      return (c.init.headers as Record<string, string>).Authorization === "Bearer t1"
        ? json(401, {})
        : json(200, mixedFixture);
    });
    expect(await search.search(query())).toHaveLength(3);
    expect(calls.filter(isToken)).toHaveLength(2);
  });

  it("rejects on a second 401", async () => {
    const { search } = setup((c) => (isToken(c) ? json(200, tokenFixture) : json(401, {})));
    expect(await code(search.search(query()))).toBe("AUTH_FAILED");
  });

  it("rejects 400 and 401 from the token endpoint", async () => {
    for (const status of [400, 401]) {
      const { search } = setup(() => json(status, { error: "invalid_client" }));
      expect(await code(search.search(query()))).toBe("AUTH_FAILED");
    }
  });

  it("rejects NOT_CONFIGURED without a request", async () => {
    const { search, calls } = setup(ok, {
      getConfig: () => {
        throw new Error(`bad ${SECRET}`);
      },
    });
    expect(await code(search.search(query()))).toBe("NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
});

describe("other errors", () => {
  const cases: Record<string, Responder> = {
    "403": (c) => (isToken(c) ? json(200, tokenFixture) : json(403, {})),
    "500": (c) => (isToken(c) ? json(200, tokenFixture) : json(500, {})),
    "not JSON": (c) =>
      isToken(c) ? json(200, tokenFixture) : new Response("<html>", { status: 200 }),
    "no items": (c) => (isToken(c) ? json(200, tokenFixture) : json(200, { tracks: {} })),
    "network error": (c) => {
      if (isToken(c)) return json(200, tokenFixture);
      throw new TypeError(`connect failed ${TOKEN}`);
    },
    "token response without token": () => json(200, {}),
  };

  for (const [name, responder] of Object.entries(cases)) {
    it(`UNAVAILABLE on ${name}, without retry`, async () => {
      const { search, calls } = setup(responder);
      expect(await code(search.search(query()))).toBe("UNAVAILABLE");
      expect(searchCalls(calls).length).toBeLessThanOrEqual(1);
    });
  }

  it("UNAVAILABLE on timeout", async () => {
    const hang: Responder = (c) =>
      isToken(c)
        ? json(200, tokenFixture)
        : new Promise<Response>((_, reject) => {
            (c.init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("abort")));
          });
    const { search } = setup(hang, { requestTimeoutMs: 20 });
    expect(await code(search.search(query()))).toBe("UNAVAILABLE");
  });
});

describe("errors are safe", () => {
  it("leaks no secret through message, JSON or the console", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const secretBody = { error: `leak ${SECRET} ${TOKEN}` };
    const scenarios: Responder[] = [
      () => json(401, secretBody),
      () => json(500, secretBody),
      (c) => (isToken(c) ? json(200, tokenFixture) : json(401, secretBody)),
      (c) => (isToken(c) ? json(200, tokenFixture) : json(429, secretBody)),
      (c) => (isToken(c) ? json(200, tokenFixture) : json(403, secretBody)),
      (c) => {
        if (isToken(c)) return json(200, tokenFixture);
        throw new Error(`${SECRET} ${TOKEN}`);
      },
    ];
    const errors: SpotifyError[] = [];
    for (const s of scenarios) {
      const { search } = setup(s);
      try {
        await search.search(query({ text: "secret-query-text" }));
      } catch (e) {
        errors.push(e as SpotifyError);
      }
    }
    errors.push(
      await createSpotifySearch({
        now: () => 0,
        getConfig: () => {
          throw new Error(SECRET);
        },
      })
        .search(query())
        .catch((e) => e),
    );
    expect(errors).toHaveLength(scenarios.length + 1);
    for (const e of errors) {
      expect(e).toBeInstanceOf(SpotifyError);
      const text = e.message + JSON.stringify(e) + String(e.stack?.split("\n")[0]);
      for (const bad of [SECRET, TOKEN, CLIENT_ID, "secret-query-text", "spotify.com"]) {
        expect(text).not.toContain(bad);
      }
      expect(e.cause).toBeUndefined();
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("no invented tracks, only search", () => {
  it("returns Spotify's ids in order and requests only the two endpoints", async () => {
    const urls: string[] = [];
    const record: Responder = (c, n) => {
      urls.push(c.url);
      return n % 3 === 0 ? json(429, {}, { "Retry-After": "1" }) : ok(c, n);
    };
    const { search } = setup(record);
    const out = (await search.search(query())) as { spotifyId: string }[];
    expect(out.map((t) => t.spotifyId)).toEqual(
      mixedFixture.tracks.items
        .filter((i) => i && i.id !== "bad id")
        .map((i) => (i as { id: string }).id),
    );
    await search.search(query({ limit: 20 })).catch(() => {});
    for (const url of urls) {
      expect(url).toMatch(
        /^(https:\/\/accounts\.spotify\.com\/api\/token|https:\/\/api\.spotify\.com\/v1\/search\?)/,
      );
    }
  });
});
