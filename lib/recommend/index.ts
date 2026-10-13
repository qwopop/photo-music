import { buildSearchCriteria } from "../criteria";
import type { MoodResult } from "../mood";
import { playlistSchema, trackSchema, youtubeLinkSchema } from "../playlist";
import type { Playlist, PlaylistTrack, Track, YouTubeLink } from "../playlist";
import type { Preferences } from "../preferences";

export interface TrackQuery {
  text: string;
  genre?: string;
  artist?: string;
  languages: string[];
  limit: number;
}

export interface TrackSearch {
  search(query: TrackQuery): Promise<unknown[]>;
}

export interface VideoLinkResolver {
  resolve(track: Track): Promise<unknown>;
}

export interface RecommendDeps {
  search: TrackSearch;
  videos: VideoLinkResolver;
}

export type RecommendErrorCode = "SEARCH_UNAVAILABLE" | "NO_TRACKS";

const ERROR_MESSAGES: Record<RecommendErrorCode, string> = {
  SEARCH_UNAVAILABLE: "Music search is unavailable right now. Please try again later.",
  NO_TRACKS: "No matching tracks were found. Try different preferences.",
};

export class RecommendError extends Error {
  readonly code: RecommendErrorCode;

  constructor(code: RecommendErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RecommendError";
    this.code = code;
  }
}

const SEARCH_LIMIT = 20;
const MAX_GENRE_QUERIES = 3;
const MAX_ARTIST_QUERIES = 3;
const ARTIST_QUERY_WEIGHT = 0.3;
const SEARCH_TIMEOUT_MS = 10_000;
const VIDEO_TIMEOUT_MS = 5_000;
const MAX_TRACKS_PER_ARTIST = 2;

interface PlannedQuery {
  query: TrackQuery;
  weight: number;
}

interface Candidate {
  track: Track;
  firstQuery: number;
  firstPosition: number;
  queries: Set<number>;
  score: number;
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function planQueries(mood: MoodResult, preferences: Preferences): PlannedQuery[] {
  const criteria = buildSearchCriteria(mood, preferences);
  const text = criteria.keywords.slice(0, 2).join(" ");
  const languages = [...preferences.languages];
  const genres = criteria.genres.slice(0, MAX_GENRE_QUERIES);
  const artists = preferences.artists.slice(0, MAX_ARTIST_QUERIES);
  const queries: PlannedQuery[] = genres.map(({ genre, weight }) => ({
    query: { text, genre, languages: [...languages], limit: SEARCH_LIMIT },
    weight,
  }));

  const artistWeight = artists.length === 0 ? 0 : ARTIST_QUERY_WEIGHT / artists.length;
  for (const artist of artists) {
    queries.push({
      query: { text: artist, artist, languages: [...languages], limit: SEARCH_LIMIT },
      weight: artistWeight,
    });
  }
  return queries;
}

const normalize = (value: string) => value.toLowerCase().trim().replace(/\s+/g, " ");

function collectCandidates(results: (unknown[] | null)[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  const seenSongs = new Set<string>();
  const candidates: Candidate[] = [];

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
      if (seenSongs.has(songKey)) return;
      seenSongs.add(songKey);

      const candidate: Candidate = {
        track,
        firstQuery: queryIndex,
        firstPosition: position,
        queries: new Set([queryIndex]),
        score: 0,
      };
      byId.set(track.spotifyId, candidate);
      candidates.push(candidate);
    });
  });

  return candidates;
}

function scoreCandidate(candidate: Candidate, queries: PlannedQuery[], preferenceArtists: Set<string>): number {
  let score = 0;
  for (const queryIndex of candidate.queries) score += queries[queryIndex].weight;
  if (candidate.track.artists.some((artist) => preferenceArtists.has(artist.toLowerCase()))) score += 1;
  return score;
}

const stableScore = (value: number) => Math.round(value * 1_000_000_000);

function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      stableScore(b.score) - stableScore(a.score) ||
      a.firstQuery - b.firstQuery ||
      a.firstPosition - b.firstPosition ||
      (a.track.spotifyId < b.track.spotifyId ? -1 : a.track.spotifyId > b.track.spotifyId ? 1 : 0),
  );
}

function selectVaried(candidates: Candidate[], requestedLength: number): Candidate[] {
  const counts = new Map<string, number>();
  const selected: Candidate[] = [];
  const skipped: Candidate[] = [];

  for (const candidate of candidates) {
    if (selected.length === requestedLength) break;
    const artist = normalize(candidate.track.artists[0]);
    const count = counts.get(artist) ?? 0;
    if (count >= MAX_TRACKS_PER_ARTIST) {
      skipped.push(candidate);
      continue;
    }
    counts.set(artist, count + 1);
    selected.push(candidate);
  }

  for (const candidate of skipped) {
    if (selected.length === requestedLength) break;
    selected.push(candidate);
  }

  const positions = new Map(candidates.map((candidate, index) => [candidate, index]));
  return selected.sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
}

function createMatchReason(candidate: Candidate, queries: PlannedQuery[], mood: MoodResult): string {
  const foundByGenres: string[] = [];
  const foundByArtists: string[] = [];
  for (const queryIndex of candidate.queries) {
    const query = queries[queryIndex].query;
    if (query.genre) foundByGenres.push(query.genre);
    if (query.artist) foundByArtists.push(query.artist);
  }

  const sources = [
    foundByGenres.length > 0 ? `${foundByGenres.join(", ")} genre` : null,
    foundByArtists.length === 1
      ? `your chosen artist ${foundByArtists[0]}`
      : foundByArtists.length > 1
        ? `your chosen artists ${foundByArtists.join(", ")}`
        : null,
  ].filter((source): source is string => source !== null);
  const reason = `May suit a ${mood.primaryEmotion} mood; it was returned by ${sources.join(" and ")} searches.`;
  if (reason.length <= 300) return reason;

  const conciseSources = [
    foundByGenres.length > 0 ? `${foundByGenres.join(", ")} genre` : null,
    foundByArtists.length > 0 ? "your chosen artist" : null,
  ].filter((source): source is string => source !== null);
  return `May suit a ${mood.primaryEmotion} mood; it was returned by ${conciseSources.join(" and ")} searches.`;
}

function searchLink(track: Track): YouTubeLink {
  const searchQuery = encodeURIComponent(`${track.title} ${track.artists[0]}`);
  return youtubeLinkSchema.parse({
    kind: "search",
    url: `https://www.youtube.com/results?search_query=${searchQuery}`,
  });
}

async function resolveVideo(videos: VideoLinkResolver, track: Track): Promise<YouTubeLink> {
  try {
    const answer = await withTimeout(() => videos.resolve(track), VIDEO_TIMEOUT_MS);
    const parsed = youtubeLinkSchema.safeParse(answer);
    if (parsed.success) return parsed.data;
  } catch {
    // Provider failures are intentionally reduced to a search link.
  }
  return searchLink(track);
}

export async function recommendPlaylist(
  mood: MoodResult,
  preferences: Preferences,
  deps: RecommendDeps,
): Promise<Playlist> {
  const queries = planQueries(mood, preferences);
  const results = await Promise.all(
    queries.map(async ({ query }) => {
      try {
        const result = await withTimeout(() => deps.search.search(query), SEARCH_TIMEOUT_MS);
        return Array.isArray(result) ? result : [];
      } catch {
        return null;
      }
    }),
  );

  if (results.every((result) => result === null)) throw new RecommendError("SEARCH_UNAVAILABLE");

  const candidates = collectCandidates(results);
  if (candidates.length === 0) throw new RecommendError("NO_TRACKS");

  const preferenceArtists = new Set(preferences.artists.map((artist) => artist.toLowerCase()));
  for (const candidate of candidates) {
    candidate.score = scoreCandidate(candidate, queries, preferenceArtists);
  }

  const selected = selectVaried(rankCandidates(candidates), preferences.length);
  const tracks: PlaylistTrack[] = await Promise.all(
    selected.map(async (candidate) => ({
      ...candidate.track,
      youtube: await resolveVideo(deps.videos, candidate.track),
      matchReason: createMatchReason(candidate, queries, mood),
    })),
  );

  return playlistSchema.parse({
    mood,
    preferences,
    requestedLength: preferences.length,
    tracks,
    featuredTrackId: tracks[0].spotifyId,
  });
}
