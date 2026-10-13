import type { Track } from "../playlist";
import type { TrackQuery, TrackSearch, VideoLinkResolver } from "./index";

// Synthetic fakes for tests only. Not real songs or provider responses.

export function fakeTrack(n: number, extra: Partial<Track> = {}): Track {
  const spotifyId = `FakeTrackId${String(n).padStart(11, "0")}`;
  return {
    spotifyId,
    spotifyUrl: `https://open.spotify.com/track/${spotifyId}`,
    title: `Fake Song ${n}`,
    artists: [`Fake Artist ${n}`],
    album: `Fake Album ${n}`,
    durationMs: 180_000,
    coverImageUrl: null,
    ...extra,
  };
}

/** Records every query; answers from `answer` (default: nothing). */
export class RecordingSearch implements TrackSearch {
  readonly queries: TrackQuery[] = [];
  constructor(private readonly answer: (query: TrackQuery) => unknown[] | Promise<unknown[]> = () => []) {}
  async search(query: TrackQuery): Promise<unknown[]> {
    this.queries.push(query);
    return this.answer(query);
  }
}

export class RecordingVideos implements VideoLinkResolver {
  readonly resolved: Track[] = [];
  constructor(private readonly answer: (track: Track) => unknown | Promise<unknown> = (t) => ({
    kind: "video",
    url: `https://www.youtube.com/watch?v=${t.spotifyId.slice(-11)}`,
  })) {}
  async resolve(track: Track): Promise<unknown> {
    this.resolved.push(track);
    return this.answer(track);
  }
}
