import type { MoodResult, PrimaryEmotion } from "../mood";
import type { GENRES, Preferences, SITUATIONS } from "../preferences";

export type Genre = (typeof GENRES)[number];
export type Situation = (typeof SITUATIONS)[number];

export type SearchCriteria = {
  genres: { genre: Genre; weight: number }[];
  energy: number;
  tempo: { minBpm: number; maxBpm: number };
  keywords: string[];
  artists: string[];
  languages: string[];
  weights: { mood: number; preferences: number; situation: number };
};

type Source = keyof SearchCriteria["weights"];

/** Source weights before rescaling. Photo mood weighs most. */
export const SOURCE_WEIGHTS: Readonly<Record<Source, number>> = {
  mood: 0.6,
  preferences: 0.3,
  situation: 0.1,
};

export const MIN_BPM = 40;
export const MAX_BPM = 200;
export const MAX_KEYWORDS = 8;

export type EmotionMapping = {
  energy: number;
  tempo: { minBpm: number; maxBpm: number };
  genres: readonly Genre[];
  keywords: readonly string[];
};

export const EMOTION_MAPPINGS: Readonly<Record<PrimaryEmotion, EmotionMapping>> = {
  happy: { energy: 0.75, tempo: { minBpm: 110, maxBpm: 140 }, genres: ["pop", "indie", "electronic"], keywords: ["upbeat", "feel good"] },
  sad: { energy: 0.25, tempo: { minBpm: 60, maxBpm: 90 }, genres: ["folk", "indie", "ambient"], keywords: ["melancholic", "sad"] },
  calm: { energy: 0.2, tempo: { minBpm: 60, maxBpm: 90 }, genres: ["ambient", "lo-fi", "classical", "jazz"], keywords: ["calm", "peaceful"] },
  energetic: { energy: 0.9, tempo: { minBpm: 125, maxBpm: 170 }, genres: ["electronic", "rock", "hip-hop"], keywords: ["energetic", "high energy"] },
  romantic: { energy: 0.4, tempo: { minBpm: 70, maxBpm: 100 }, genres: ["r-and-b", "jazz", "pop"], keywords: ["romantic", "love"] },
};

export type SituationMapping = {
  energyChange: number;
  genres: readonly Genre[];
  keyword: string;
};

export const SITUATION_MAPPINGS: Readonly<Record<Situation, SituationMapping>> = {
  studying: { energyChange: -0.15, genres: ["lo-fi", "ambient", "classical"], keyword: "focus" },
  "walking-at-night": { energyChange: -0.05, genres: ["electronic", "ambient", "indie"], keyword: "night" },
  relaxing: { energyChange: -0.2, genres: ["ambient", "jazz", "lo-fi"], keyword: "relax" },
  driving: { energyChange: 0.15, genres: ["rock", "pop", "electronic"], keyword: "road trip" },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Rescale the weights of the sources that are present so they sum to 1. */
function rescaleWeights(present: Record<Source, boolean>): SearchCriteria["weights"] {
  const total = (Object.keys(SOURCE_WEIGHTS) as Source[]).reduce(
    (sum, s) => (present[s] ? sum + SOURCE_WEIGHTS[s] : sum),
    0,
  );
  const scaled = (s: Source) => (present[s] ? SOURCE_WEIGHTS[s] / total : 0);
  return { mood: scaled("mood"), preferences: scaled("preferences"), situation: scaled("situation") };
}

function buildGenres(
  groups: { genres: readonly Genre[]; weight: number }[],
): SearchCriteria["genres"] {
  const sums = new Map<Genre, number>();
  for (const { genres, weight } of groups) {
    for (const genre of genres) {
      sums.set(genre, (sums.get(genre) ?? 0) + weight / genres.length);
    }
  }
  return [...sums.entries()]
    .map(([genre, weight]) => ({ genre, weight }))
    .sort((a, b) => b.weight - a.weight || (a.genre < b.genre ? -1 : a.genre > b.genre ? 1 : 0));
}

function buildEnergy(base: number, situation: SituationMapping | null): number {
  return clamp(base + (situation?.energyChange ?? 0), 0, 1);
}

function buildTempo(base: EmotionMapping["tempo"], situation: SituationMapping | null) {
  const shift = situation ? Math.round(situation.energyChange * 100) : 0;
  return {
    minBpm: clamp(base.minBpm + shift, MIN_BPM, MAX_BPM - 1),
    maxBpm: clamp(base.maxBpm + shift, MIN_BPM + 1, MAX_BPM),
  };
}

function buildKeywords(
  emotionKeywords: readonly string[],
  secondaryMoods: readonly string[],
  situationKeyword: string | null,
): string[] {
  const keywords = [...emotionKeywords];
  const tail = situationKeyword !== null && !keywords.includes(situationKeyword) ? 1 : 0;
  for (const mood of secondaryMoods) {
    const keyword = mood.trim().toLowerCase();
    if (keyword === "" || keyword === situationKeyword || keywords.includes(keyword)) continue;
    if (keywords.length + tail >= MAX_KEYWORDS) break;
    keywords.push(keyword);
  }
  if (situationKeyword !== null && !keywords.includes(situationKeyword)) keywords.push(situationKeyword);
  return keywords;
}

/**
 * Pure mapping from a mood and preferences to music search criteria.
 * Trusts its inputs to satisfy moodResultSchema and preferencesSchema.
 *
 * `mood.confidence` is deliberately ignored: the mood is already an
 * interpretation, and a low-confidence mood is corrected by the user (#14),
 * not guessed around here. Artists and languages are passed through only.
 */
export function buildSearchCriteria(mood: MoodResult, preferences: Preferences): SearchCriteria {
  const emotion = EMOTION_MAPPINGS[mood.primaryEmotion];
  const situation = preferences.situation === null ? null : SITUATION_MAPPINGS[preferences.situation];
  const weights = rescaleWeights({
    mood: true,
    preferences: preferences.genres.length > 0,
    situation: situation !== null,
  });
  return {
    genres: buildGenres([
      { genres: emotion.genres, weight: weights.mood },
      { genres: preferences.genres, weight: weights.preferences },
      { genres: situation?.genres ?? [], weight: weights.situation },
    ]),
    energy: buildEnergy(emotion.energy, situation),
    tempo: buildTempo(emotion.tempo, situation),
    keywords: buildKeywords(emotion.keywords, mood.secondaryMoods, situation?.keyword ?? null),
    artists: [...preferences.artists],
    languages: [...preferences.languages],
    weights,
  };
}
