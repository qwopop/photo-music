import { describe, expect, it, vi } from "vitest";
import type { Track } from "../playlist";
import { createYouTubeResolver, NO_RESULT_CACHE_TTL_MS, VIDEO_CACHE_TTL_MS, type YouTubeCacheEntry, type YouTubeCacheStore } from "./index";

const track = (title = "Song", artist = "Artist"): Track => ({
  spotifyId: "a".repeat(22), spotifyUrl: `https://open.spotify.com/track/${"a".repeat(22)}`,
  title, artists: [artist, "ignored"], album: null, durationMs: 1000, coverImageUrl: null,
});
const video = { kind: "video" as const, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" };
function shared() {
  const entries = new Map<string, YouTubeCacheEntry>();
  const store: YouTubeCacheStore = {
    get: vi.fn(async (key) => entries.get(JSON.stringify(key)) ?? null),
    set: vi.fn(async (key, entry) => { entries.set(JSON.stringify(key), entry); }),
  };
  return store;
}
function provider(found = true) {
  return vi.fn(async () => new Response(JSON.stringify({ items: found ? [
    { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Song", channelTitle: "Artist" } },
  ] : [] })));
}

describe("injected shared YouTube cache", () => {
  it("reuses normalized title and first artist across new resolver instances", async () => {
    const cacheStore = shared();
    const fetch = provider();
    const options = { apiKey: "key", fetch, cacheStore, now: () => 1000 };
    expect(await createYouTubeResolver(options).resolve(track())).toEqual(video);
    expect(await createYouTubeResolver(options).resolve(track(" song ", " ARTIST  "))).toEqual(video);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cacheStore.set).toHaveBeenCalledWith({ title: "song", firstArtist: "artist" }, { link: video, fetchedAt: 1000 });
    await createYouTubeResolver(options).resolve(track("Song", "Other Artist"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([[true, VIDEO_CACHE_TTL_MS], [false, NO_RESULT_CACHE_TTL_MS]])(
    "uses the original fetchedAt lifetime for found=%s, including exact expiry", async (found, ttl) => {
      const cacheStore = shared();
      const fetch = provider(found);
      let clock = 1000;
      const options = { apiKey: "key", fetch, cacheStore, now: () => clock };
      await createYouTubeResolver(options).resolve(track());
      clock += ttl - 1;
      const reader = createYouTubeResolver(options);
      await reader.resolve(track());
      expect(fetch).toHaveBeenCalledTimes(1);
      clock++;
      await reader.resolve(track());
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("falls back to memory for read and write failures without leaking errors", async () => {
    const cacheStore: YouTubeCacheStore = {
      get: vi.fn(async () => { throw new Error("private query parameters"); }),
      set: vi.fn(async () => { throw new Error("private query parameters"); }),
    };
    const fetch = provider();
    const resolver = createYouTubeResolver({ apiKey: "key", fetch, cacheStore });
    expect(await resolver.resolve(track())).toEqual(video);
    expect(await resolver.resolve(track())).toEqual(video);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cacheStore.get).toHaveBeenCalledTimes(1);
    expect(cacheStore.set).toHaveBeenCalledTimes(1);
  });

  it("shares a persistent read between concurrent equivalent requests", async () => {
    const cacheStore = shared();
    const fetch = provider();
    const resolver = createYouTubeResolver({ apiKey: "key", fetch, cacheStore });
    await Promise.all([resolver.resolve(track()), resolver.resolve(track(" song ", "ARTIST"))]);
    expect(cacheStore.get).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not persist provider failures", async () => {
    const cacheStore = shared();
    const fetch = vi.fn(async () => new Response("down", { status: 500 }));
    const resolver = createYouTubeResolver({ apiKey: "key", fetch, cacheStore });
    await resolver.resolve(track());
    await resolver.resolve(track());
    expect(cacheStore.set).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([NaN, 2000])("ignores invalid or future fetchedAt %s", async (fetchedAt) => {
    const cacheStore = shared();
    await cacheStore.set({ title: "song", firstArtist: "artist" }, { link: video, fetchedAt });
    const fetch = provider();
    await createYouTubeResolver({ apiKey: "key", fetch, cacheStore, now: () => 1000 }).resolve(track());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
