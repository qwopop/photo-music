import { buildSearchCriteria } from "../criteria";
import type { MoodResult } from "../mood";
import { playlistSchema, trackSchema, youtubeLinkSchema } from "../playlist";
import type { Playlist, PlaylistTrack, Track, YouTubeLink } from "../playlist";
import type { Preferences } from "../preferences";

// Pure engine: no environment, no connection, no vision code. The real
// providers (#17 Spotify, #18 YouTube) are passed in by the caller.

export type TrackQuery = {
  text: string;
  genre?: string;
  artist?: string;
  languages: string[];
  limit: number;
};

export interface TrackSearch {
  search(query: TrackQuery): Promise<unknown[]>;
}

export interface VideoLinkResolver {
  resolve(track: Track): Promise<unknown>;
}

export type RecommendDeps = { search: TrackSearch; videos: VideoLinkResolver };

export const RECOMMEND_ERROR_CODES = ["SEARCH_UNAVAILABLE", "NO_TRACKS"] as const;
export type RecommendErrorCode = (typeof RECOMMEND_ERROR_CODES)[number];

const ERROR_MESSAGES: Record<RecommendErrorCode, string> = {
  SEARCH_UNAVAILABLE: "Music search is unavailable right now. Please try again later.",
  NO_TRACKS: "No matching tracks were found. Try different preferences.",
};

/** Stable code and fixed user-safe message; never carries a cause or provider text. */
export class RecommendError extends Error {
  readonly code: RecommendErrorCode;
  constructor(code: RecommendErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RecommendError";
    this.code = code;
  }
}

export const SEARCH_LIMIT = 20;
export const MAX_GENRE_QUERIES = 3;
export const MAX_ARTIST_QUERIES = 3;
export const ARTIST_QUERY_WEIGHT = 0.3;
export const PREFERENCE_ARTIST_BONUS = 1;
export const MAX_TRACKS_PER_ARTIST = 2;
export const SEARCH_TIMEOUT_MS = 10_000;
export const VIDEO_TIMEOUT_MS = 5_000;

type PlannedQuery = { query: TrackQuery; weight: number };

function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function planQueries(mood: MoodResult, preferences: Preferences): PlannedQuery[] {
  const criteria = buildSearchCriteria(mood, preferences);
  const text = criteria.keywords.slice(0, 2).join(" ");
  const languages = [...criteria.languages];
  const artists = criteria.artists.slice(0, MAX_ARTIST_QUERIES);
  const planned: PlannedQuery[] = criteria.genres.slice(0, MAX_GENRE_QUERIES).map((g) => ({
    query: { text, genre: g.genre, languages: [...languages], limit: SEARCH_LIMIT },
    weight: g.weight,
  }));
  for (const artist of artists) {
    planned.push({
      query: { text: artist, artist, languages: [...languages], limit: SEARCH_LIMIT },
      weight: ARTIST_QUERY_WEIGHT / artists.length,
    });
  }
  return planned;
}

const normalize = (value: string) => value.toLowerCase().trim().replace(/\s+/g, " ");

type Candidate = {
  track: Track;
  firstQuery: number;
  firstPosition: number;
  queries: Set<number>;
  score: number;
};

function collectCandidates(results: (unknown[] | null)[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  const bySong = new Set<string>();
  const ordered: Candidate[] = [];
  results.forEach((items, queryIndex) => {
    if (items === null) return;
    items.forEach((item, position) => {
      const parsed = trackSchema.safeParse(item);
      if (!parsed.success) return;
      const track = parsed.data;
      const existing = byId.get(track.spotifyId);
      if (existing) {
        existing.queries.add(queryIndex);
        return;
      }
      const songKey = `${normalize(track.title)}\u0000${normalize(track.artists[0])}`;
      if (bySong.has(songKey)) return;
      bySong.add(songKey);
      const candidate: Candidate = { track, firstQuery: queryIndex, firstPosition: position, queries: new Set([queryIndex]), score: 0 };
      byId.set(track.spotifyId, candidate);
      ordered.push(candidate);
    });
  });
  return ordered;
}

function score(candidate: Candidate, planned: PlannedQuery[], preferenceArtists: Set<string>): number {
  let total = 0;
  for (const index of candidate.queries) total += planned[index].weight;
  if (candidate.track.artists.some((a) => preferenceArtists.has(a.toLowerCase()))) total += PREFERENCE_ARTIST_BONUS;
  return total;
}

const roundScore = (value: number) => Math.round(value * 1e9);

function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      roundScore(b.score) - roundScore(a.score) ||
      a.firstQuery - b.firstQuery ||
      a.firstPosition - b.firstPosition ||
      (a.track.spotifyId < b.track.spotifyId ? -1 : a.track.spotifyId > b.track.spotifyId ? 1 : 0),
  );
}

function selectVaried(ranked: Candidate[], length: number): Candidate[] {
  const counts = new Map<string, number>();
  const chosen: Candidate[] = [];
  const skipped: Candidate[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= length) break;
    const key = normalize(candidate.track.artists[0]);
    const count = counts.get(key) ?? 0;
    if (count >= MAX_TRACKS_PER_ARTIST) {
      skipped.push(candidate);
      continue;
    }
    counts.set(key, count + 1);
    chosen.push(candidate);
  }
  for (const candidate of skipped) {
    if (chosen.length >= length) break;
    chosen.push(candidate);
  }
  const position = new Map(ranked.map((c, i) => [c, i]));
  return chosen.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
}

function matchReason(candidate: Candidate, planned: PlannedQuery[], mood: MoodResult): string {
  const genres: string[] = [];
  const artists: string[] = [];
  for (const index of [...candidate.queries].sort((a, b) => a - b)) {
    const { genre, artist } = planned[index].query;
    if (genre) genres.push(genre);
    if (artist) artists.push(artist);
  }
  const build = (withArtistNames: boolean) => {
    const parts: string[] = [];
    if (genres.length > 0) parts.push(`a search for ${genres.join(", ")}`);
    if (artists.length > 0) {
      parts.push(withArtistNames ? `your chosen artist ${artists.join(", ")}` : "your chosen artists");
    }
    return `May suit a ${mood.primaryEmotion} mood. Found through ${parts.join(" and ")}.`;
  };
  const full = build(true);
  return full.length <= 300 ? full : build(false);
}

function searchLink(track: Track): YouTubeLink {
  const query = encodeURIComponent(`${track.title} ${track.artists[0]}`);
  return { kind: "search", url: `https://www.youtube.com/results?search_query=${query}` };
}

async function resolveVideo(videos: VideoLinkResolver, track: Track): Promise<YouTubeLink> {
  try {
    const answer = await withTimeout(() => videos.resolve(track), VIDEO_TIMEOUT_MS);
    const parsed = youtubeLinkSchema.safeParse(answer);
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the search link; provider text is never kept.
  }
  const fallback = searchLink(track);
  return youtubeLinkSchema.safeParse(fallback).success ? fallback : { kind: "search", url: "https://www.youtube.com/results?search_query=music" };
}

export async function recommendPlaylist(
  mood: MoodResult,
  preferences: Preferences,
  deps: RecommendDeps,
): Promise<Playlist> {
  const planned = planQueries(mood, preferences);
  const results = await Promise.all(
    planned.map(async ({ query }) => {
      try {
        const items = await withTimeout(() => deps.search.search(query), SEARCH_TIMEOUT_MS);
        return Array.isArray(items) ? items : null;
      } catch {
        return null;
      }
    }),
  );
  if (results.every((r) => r === null)) throw new RecommendError("SEARCH_UNAVAILABLE");

  const candidates = collectCandidates(results);
  if (candidates.length === 0) throw new RecommendError("NO_TRACKS");

  const preferenceArtists = new Set(preferences.artists.map((a) => a.toLowerCase()));
  for (const candidate of candidates) candidate.score = score(candidate, planned, preferenceArtists);

  const chosen = selectVaried(rank(candidates), preferences.length);
  const tracks: PlaylistTrack[] = await Promise.all(
    chosen.map(async (candidate) => ({
      ...candidate.track,
      youtube: await resolveVideo(deps.videos, candidate.track),
      matchReason: matchReason(candidate, planned, mood),
    })),
  );
  return playlistSchema.parse({
    mood,
    requestedLength: preferences.length,
    tracks,
    featuredTrackId: tracks[0].spotifyId,
  });
}
