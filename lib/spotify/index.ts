/**
 * Spotify track search (client credentials flow, search endpoint only).
 * Server-only.
 *
 * Importing this module reads no environment variable, and
 * `createSpotifySearch()` makes no request. The config is read from
 * `getSpotifyConfig()` when a token is first needed, so call `search` only
 * while handling a request.
 *
 * The only URLs ever requested are the token endpoint and `/v1/search`.
 * Nothing is ranked, deduplicated or invented here: the output is what
 * Spotify returned, in its order, minus items that fail `trackSchema`.
 * Errors are `SpotifyError`s with a fixed message; they never contain a
 * token, a client id or secret, a URL, a query or a response body, and this
 * module never writes to the console.
 */
import "server-only";

import { getSpotifyConfig, type SpotifyConfig } from "../config";
import { trackSchema, type Track } from "../playlist";

/**
 * The query a recommendation engine sends to a music provider. Defined here
 * because #20 has not merged yet; #20 should import it instead.
 */
export interface TrackQuery {
  text: string;
  genre?: string;
  artist?: string;
  languages: string[];
  limit: number;
}

/** A music provider's track search. Results are unchecked (`unknown[]`). */
export interface TrackSearch {
  search(query: TrackQuery): Promise<unknown[]>;
}

/** Spotify's documented search page size limit; to be confirmed by #51. */
export const MAX_PAGE_SIZE = 10;
/** The largest `limit` a query may ask for. */
export const MAX_LIMIT = 50;
/** A token counts as expired this long before its `expires_in`. */
export const TOKEN_SAFETY_MARGIN_MS = 60_000;
/** The longest `Retry-After` (seconds) that is waited for. */
export const MAX_RETRY_AFTER_SECONDS = 5;
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SEARCH_URL = "https://api.spotify.com/v1/search";

export type SpotifyErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "INVALID_QUERY"
  | "UNAVAILABLE";

const MESSAGES: Record<SpotifyErrorCode, string> = {
  NOT_CONFIGURED: "Spotify is not configured.",
  AUTH_FAILED: "Spotify rejected the request credentials.",
  RATE_LIMITED: "Spotify is busy. Try again later.",
  INVALID_QUERY: "The track search query is not valid.",
  UNAVAILABLE: "Spotify is unavailable.",
};

export class SpotifyError extends Error {
  readonly code: SpotifyErrorCode;

  constructor(code: SpotifyErrorCode) {
    super(MESSAGES[code]);
    this.name = "SpotifyError";
    this.code = code;
  }
}

export interface SpotifySearchDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  getConfig?: () => SpotifyConfig;
  requestTimeoutMs?: number;
}

interface Reply {
  status: number;
  retryAfter: string | null;
  body: unknown;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const unavailable = () => new SpotifyError("UNAVAILABLE");

export function buildSearchString(query: TrackQuery): string {
  const parts: string[] = [];
  if (typeof query.text === "string" && query.text.trim() !== "") parts.push(query.text.trim());
  // `languages` is accepted and ignored: Spotify search has no language filter.
  const quoted = (field: string, value: unknown) => {
    if (typeof value === "string") parts.push(`${field}:"${value.replaceAll('"', "")}"`);
  };
  if (query.genre !== undefined) quoted("genre", query.genre);
  if (query.artist !== undefined) quoted("artist", query.artist);
  return parts.join(" ");
}

function mapItem(item: unknown): Track | null {
  if (typeof item !== "object" || item === null) return null;
  const raw = item as Record<string, unknown>;
  const album = raw.album as { name?: unknown; images?: unknown } | null | undefined;
  const hasAlbum = typeof album === "object" && album !== null;
  const images = hasAlbum ? album.images : undefined;
  const firstImage = Array.isArray(images) ? (images[0] as { url?: unknown } | null) : undefined;
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map((a: { name?: unknown } | null) => a?.name)
    : undefined;
  const candidate = {
    spotifyId: raw.id,
    spotifyUrl: "https://open.spotify.com/track/" + String(raw.id),
    title: raw.name,
    artists,
    album: hasAlbum && album.name !== undefined ? album.name : null,
    durationMs: raw.duration_ms,
    coverImageUrl: typeof firstImage?.url === "string" ? firstImage.url : null,
  };
  const parsed = trackSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createSpotifySearch(deps: SpotifySearchDeps = {}): TrackSearch {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const getConfig = deps.getConfig ?? getSpotifyConfig;
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let cached: CachedToken | null = null;
  let pending: Promise<string> | null = null;

  async function request(url: string, init: RequestInit): Promise<Reply> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable());
      }, timeoutMs);
    });
    const work = (async (): Promise<Reply> => {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      let body: unknown;
      if (res.status >= 200 && res.status < 300) {
        try {
          body = await res.json();
        } catch {
          throw unavailable();
        }
      }
      return { status: res.status, retryAfter: res.headers?.get("Retry-After") ?? null, body };
    })();
    work.catch(() => {}); // the race below reports the outcome
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      throw error instanceof SpotifyError ? error : unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchToken(): Promise<string> {
    let config: SpotifyConfig;
    try {
      config = getConfig();
    } catch {
      throw new SpotifyError("NOT_CONFIGURED");
    }
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const requestedAt = now();
    const reply = await request(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (reply.status === 400 || reply.status === 401) throw new SpotifyError("AUTH_FAILED");
    const body = reply.body as { access_token?: unknown; expires_in?: unknown } | null;
    if (
      reply.status < 200 ||
      reply.status >= 300 ||
      typeof body !== "object" ||
      body === null ||
      typeof body.access_token !== "string" ||
      body.access_token === "" ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in)
    ) {
      throw unavailable();
    }
    cached = {
      value: body.access_token,
      expiresAt: requestedAt + body.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS,
    };
    return cached.value;
  }

  function getToken(): Promise<string> {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
    // A failed request is not cached: `pending` is cleared either way.
    pending ??= fetchToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function fetchPage(q: string, limit: number, offset: number): Promise<unknown[]> {
    const url = `${SEARCH_URL}?type=track&limit=${limit}&offset=${offset}&q=${encodeURIComponent(q)}`;
    let retriedAuth = false;
    let retriedRate = false;
    for (;;) {
      const token = await getToken();
      const reply = await request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (reply.status === 401) {
        if (retriedAuth) throw new SpotifyError("AUTH_FAILED");
        retriedAuth = true;
        cached = null;
        continue;
      }
      if (reply.status === 429) {
        const header = reply.retryAfter?.trim() ?? "";
        const seconds = /^\d+$/.test(header) ? Number(header) : NaN;
        if (retriedRate || !(seconds <= MAX_RETRY_AFTER_SECONDS)) {
          throw new SpotifyError("RATE_LIMITED");
        }
        retriedRate = true;
        await sleep(seconds * 1000);
        continue;
      }
      const items = (reply.body as { tracks?: { items?: unknown } } | null)?.tracks?.items;
      if (reply.status < 200 || reply.status >= 300 || !Array.isArray(items)) throw unavailable();
      return items;
    }
  }

  return {
    async search(query: TrackQuery): Promise<unknown[]> {
      const limit = query?.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new SpotifyError("INVALID_QUERY");
      }
      const q = buildSearchString(query);
      if (q === "") throw new SpotifyError("INVALID_QUERY");

      const tracks: Track[] = [];
      for (let offset = 0; offset < limit; offset += MAX_PAGE_SIZE) {
        const asked = Math.min(MAX_PAGE_SIZE, limit - offset);
        const items = await fetchPage(q, asked, offset);
        for (const item of items) {
          const track = mapItem(item);
          if (track) tracks.push(track);
        }
        if (items.length < asked) break;
      }
      return tracks.slice(0, limit);
    },
  };
}
