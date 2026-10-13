import type { Track } from "../playlist";
import type { TrackQuery, TrackSearch, VideoLinkResolver } from "./index";

export function fakeTrack(id: number, extra: Partial<Track> = {}): Track {
  const spotifyId = String(id).padStart(22, "0");
  return {
    spotifyId,
    spotifyUrl: `https://open.spotify.com/track/${spotifyId}`,
    title: `Example Song ${id}`,
    artists: [`Example Artist ${id}`],
    album: `Example Album ${id}`,
    durationMs: 180_000,
    coverImageUrl: null,
    ...extra,
  };
}

export class RecordingSearch implements TrackSearch {
  readonly queries: TrackQuery[] = [];

  constructor(private readonly answer: (query: TrackQuery) => unknown[] | Promise<unknown[]> = () => []) {}

  async search(query: TrackQuery): Promise<unknown[]> {
    this.queries.push(query);
    return this.answer(query);
  }
}

export class RecordingVideos implements VideoLinkResolver {
  readonly tracks: Track[] = [];

  constructor(private readonly answer: (track: Track) => unknown | Promise<unknown> = () => ({
    kind: "video",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  })) {}

  async resolve(track: Track): Promise<unknown> {
    this.tracks.push(track);
    return this.answer(track);
  }
}
