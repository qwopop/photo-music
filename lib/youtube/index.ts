import { youtubeLinkSchema, type Track, type YouTubeLink } from "../playlist";

/**
 * What the recommendation engine (#20) needs. #20 has not landed yet; its
 * engineer should import this instead of declaring its own.
 */
export interface VideoLinkResolver {
  resolve(track: Track): Promise<unknown>;
}

export interface YouTubeCacheKey { title: string; firstArtist: string }
export interface YouTubeCacheEntry { link: YouTubeLink; fetchedAt: number }
/** A shared store may throw; the resolver falls back to its bounded memory cache. */
export interface YouTubeCacheStore {
  get(key: YouTubeCacheKey): Promise<YouTubeCacheEntry | null>;
  set(key: YouTubeCacheKey, entry: YouTubeCacheEntry): Promise<void>;
}

export interface YouTubeResolverOptions {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  cacheStore?: YouTubeCacheStore;
}

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const WATCH_URL = "https://www.youtube.com/watch?v=";
const RESULTS_URL = "https://www.youtube.com/results?search_query=";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const REQUEST_TIMEOUT_MS = 4_000;
export const VIDEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NO_RESULT_CACHE_TTL_MS = 60 * 60 * 1000;
export const QUOTA_PAUSE_MS = 60 * 60 * 1000;
export const MAX_CACHE_ENTRIES = 1000;
export const MAX_CONCURRENT_REQUESTS = 3;

// Same limits as trackSchema, so a link built from a valid Track is not cut.
const MAX_TITLE_CHARS = 500;
const MAX_ARTIST_CHARS = 200;

function cut(text: string, maxChars: number): string {
  // Whole code points only, and no lone surrogates (encodeURIComponent throws on them).
  return Array.from(text.toWellFormed()).slice(0, maxChars).join("");
}

/** The fallback: a YouTube search page for the track. */
export function youTubeSearchLink(title: string, artist: string): YouTubeLink {
  const query = `${cut(title, MAX_TITLE_CHARS)} ${cut(artist, MAX_ARTIST_CHARS)}`;
  return { kind: "search", url: RESULTS_URL + encodeURIComponent(query) };
}

const squash = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function normalizedKey(track: Track): YouTubeCacheKey {
  return { title: squash(track.title), firstArtist: squash(track.artists[0] ?? "") };
}

function cacheKey(key: YouTubeCacheKey): string {
  return JSON.stringify([key.title, key.firstArtist]);
}

type Outcome =
  | { type: "found"; link: YouTubeLink }
  | { type: "none" }
  | { type: "error"; quota: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function chooseVideo(items: unknown[], title: string, artist: string): string | null {
  const wantTitle = squash(title);
  const wantArtist = squash(artist);
  let first: string | null = null;
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.id) || !isRecord(item.snippet)) continue;
    const { videoId } = item.id;
    const { title: videoTitle, channelTitle } = item.snippet;
    if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) continue;
    if (typeof videoTitle !== "string" || !squash(videoTitle).includes(wantTitle)) continue;
    first ??= videoId;
    const channel = typeof channelTitle === "string" ? channelTitle : "";
    if (wantArtist && (squash(videoTitle).includes(wantArtist) || squash(channel).includes(wantArtist))) {
      return videoId;
    }
  }
  return first;
}

async function quotaReason(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body: unknown = await response.json();
    const errors = isRecord(body) && isRecord(body.error) ? body.error.errors : undefined;
    return (
      Array.isArray(errors) &&
      errors.some((e) => isRecord(e) && (e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded"))
    );
  } catch {
    return false;
  }
}

/**
 * Looks up YouTube video links with the Data API v3 search endpoint.
 *
 * Quota: one search costs 100 of the default 10,000 daily units, so about
 * 100 uncached searches a day. Answers are cached in memory and, when injected,
 * a shared store. After a quota error no request is made for an hour.
 */
export function createYouTubeResolver(options: YouTubeResolverOptions): VideoLinkResolver {
  const { apiKey } = options;
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;

  const cache = new Map<string, { link: YouTubeLink; expires: number }>();
  const inFlight = new Map<string, Promise<YouTubeLink>>();
  let pausedUntil = 0;
  let active = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < MAX_CONCURRENT_REQUESTS) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  function release(): void {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else active--;
  }

  function store(key: string, link: YouTubeLink, expires: number): void {
    cache.delete(key);
    cache.set(key, { link, expires });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function search(title: string, artist: string): Promise<Outcome> {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoCategoryId: "10",
      maxResults: "5",
      q: `${title} ${artist}`,
      fields: "items(id/videoId,snippet(title,channelTitle))",
      key: apiKey,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const work = (async (): Promise<Outcome> => {
        const response = await doFetch(`${SEARCH_URL}?${params}`, { signal: controller.signal });
        if (!response.ok) return { type: "error", quota: await quotaReason(response) };
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.items)) return { type: "error", quota: false };
        const videoId = chooseVideo(body.items, title, artist);
        if (videoId === null) return { type: "none" };
        return { type: "found", link: { kind: "video", url: WATCH_URL + videoId } };
      })();
      work.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
      return await Promise.race([work, timeout]);
    } catch {
      return { type: "error", quota: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookup(key: string, track: Track): Promise<YouTubeLink> {
    const artist = track.artists[0] ?? "";
    const fallback = youTubeSearchLink(track.title, artist);
    if (options.cacheStore) {
      try {
        const hit = await options.cacheStore.get(normalizedKey(track));
        if (hit && youtubeLinkSchema.safeParse(hit.link).success && Number.isFinite(hit.fetchedAt)) {
          const expires = hit.fetchedAt + (hit.link.kind === "video" ? VIDEO_CACHE_TTL_MS : NO_RESULT_CACHE_TTL_MS);
          if (hit.fetchedAt <= now() && expires > now()) {
            store(key, hit.link, expires);
            return hit.link;
          }
        }
      } catch { /* Database unavailable: continue with the provider and memory cache. */ }
    }
    await acquire();
    try {
      if (now() < pausedUntil) return fallback;
      const outcome = await search(cut(track.title, MAX_TITLE_CHARS), cut(artist, MAX_ARTIST_CHARS));
      if (outcome.type === "error") {
        if (outcome.quota) pausedUntil = now() + QUOTA_PAUSE_MS;
        return fallback;
      }
      const link = outcome.type === "found" ? outcome.link : fallback;
      if (!youtubeLinkSchema.safeParse(link).success) return fallback;
      const fetchedAt = now();
      store(key, link, fetchedAt + (outcome.type === "found" ? VIDEO_CACHE_TTL_MS : NO_RESULT_CACHE_TTL_MS));
      try {
        await options.cacheStore?.set(normalizedKey(track), { link, fetchedAt });
      } catch { /* The successful result remains available in memory. */ }
      return link;
    } finally {
      release();
    }
  }

  return {
    async resolve(track: Track): Promise<YouTubeLink> {
      try {
        const key = cacheKey(normalizedKey(track));
        const hit = cache.get(key);
        if (hit) {
          if (hit.expires > now()) return hit.link;
          cache.delete(key);
        }
        let pending = inFlight.get(key);
        if (!pending) {
          pending = lookup(key, track).finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        return await pending;
      } catch {
        return youTubeSearchLink(String(track?.title ?? ""), String(track?.artists?.[0] ?? ""));
      }
    },
  };
}
