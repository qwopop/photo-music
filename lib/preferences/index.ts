import { z } from "zod";

export const GENRES = [
  "pop", "rock", "hip-hop", "r-and-b", "electronic", "indie",
  "folk", "jazz", "classical", "ambient", "lo-fi", "latin",
] as const;
export const LANGUAGES = [
  "english", "spanish", "french", "german", "portuguese",
  "italian", "russian", "japanese", "korean",
] as const;
export const SITUATIONS = ["studying", "walking-at-night", "relaxing", "driving"] as const;
export const PREFERENCE_LENGTHS = [5, 10, 20, 30] as const;

export const MAX_ARTISTS = 10;
export const MAX_ARTIST_LENGTH = 100;

const unique = <T,>(items: T[]) => new Set(items).size === items.length;

const artistSchema = z.string().trim().min(1).max(MAX_ARTIST_LENGTH);

/** Plain shared data contract; browser and server compatible. */
export const preferencesSchema = z.strictObject({
  genres: z.array(z.enum(GENRES)).refine(unique, "Genres must not repeat."),
  artists: z
    .array(artistSchema)
    .max(MAX_ARTISTS)
    .refine((names) => unique(names.map((n) => n.toLowerCase())), "Artists must not repeat."),
  languages: z.array(z.enum(LANGUAGES)).refine(unique, "Languages must not repeat."),
  situation: z.enum(SITUATIONS).nullable(),
  length: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(30)]),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  genres: [],
  artists: [],
  languages: [],
  situation: null,
  length: 10,
};

function pickIds<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const out: T[] = [];
  for (const v of values) {
    const id = allowed.find((a) => a === v);
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Never throws; always returns a valid Preferences. */
export function parsePreferences(params: URLSearchParams): Preferences {
  const artists: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll("artist")) {
    const name = raw.trim();
    if (name.length === 0 || name.length > MAX_ARTIST_LENGTH) continue;
    const key = name.toLowerCase();
    if (seen.has(key) || artists.length >= MAX_ARTISTS) continue;
    seen.add(key);
    artists.push(name);
  }
  const situationRaw = params.get("situation");
  const lengthRaw = params.get("length");
  const length = PREFERENCE_LENGTHS.find((l) => String(l) === lengthRaw);
  const candidate = {
    genres: pickIds(params.getAll("genre"), GENRES),
    artists,
    languages: pickIds(params.getAll("language"), LANGUAGES),
    situation: SITUATIONS.find((s) => s === situationRaw) ?? null,
    length: length ?? DEFAULT_PREFERENCES.length,
  };
  const result = preferencesSchema.safeParse(candidate);
  return result.success ? result.data : { ...DEFAULT_PREFERENCES };
}

/** Repeated keys; default values are left out, so defaults give an empty query. */
export function serializePreferences(preferences: Preferences): URLSearchParams {
  const params = new URLSearchParams();
  for (const g of preferences.genres) params.append("genre", g);
  for (const a of preferences.artists) params.append("artist", a);
  for (const l of preferences.languages) params.append("language", l);
  if (preferences.situation !== null) params.set("situation", preferences.situation);
  if (preferences.length !== DEFAULT_PREFERENCES.length) params.set("length", String(preferences.length));
  return params;
}
