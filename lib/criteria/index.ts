import type { MoodResult, PrimaryEmotion } from "../mood";
import type { GENRES, Preferences, SITUATIONS } from "../preferences";

export type Genre = (typeof GENRES)[number];
export type Situation = (typeof SITUATIONS)[number];

export interface SearchCriteria {
  genres: { genre: Genre; weight: number }[];
  energy: number;
  tempo: { minBpm: number; maxBpm: number };
  keywords: string[];
  artists: string[];
  languages: string[];
  weights: { mood: number; preferences: number; situation: number };
}

/** Photo mood weighs most, then the music preferences, then the situation. */
export const SOURCE_WEIGHTS = { mood: 0.6, preferences: 0.3, situation: 0.1 } as const;
export const MAX_KEYWORDS = 8;
export const MIN_BPM = 40;
export const MAX_BPM = 200;

interface EmotionMapping {
  energy: number;
  minBpm: number;
  maxBpm: number;
  genres: readonly Genre[];
  keywords: readonly string[];
}

export const EMOTION_MAPPING: Record<PrimaryEmotion, EmotionMapping> = {
  happy: { energy: 0.75, minBpm: 110, maxBpm: 140, genres: ["pop", "indie", "electronic"], keywords: ["upbeat", "feel good"] },
  sad: { energy: 0.25, minBpm: 60, maxBpm: 90, genres: ["folk", "indie", "ambient"], keywords: ["melancholic", "sad"] },
  calm: { energy: 0.2, minBpm: 60, maxBpm: 90, genres: ["ambient", "lo-fi", "classical", "jazz"], keywords: ["calm", "peaceful"] },
  energetic: { energy: 0.9, minBpm: 125, maxBpm: 170, genres: ["electronic", "rock", "hip-hop"], keywords: ["energetic", "high energy"] },
  romantic: { energy: 0.4, minBpm: 70, maxBpm: 100, genres: ["r-and-b", "jazz", "pop"], keywords: ["romantic", "love"] },
};

interface SituationMapping {
  energyChange: number;
  genres: readonly Genre[];
  keyword: string;
}

export const SITUATION_MAPPING: Record<Situation, SituationMapping> = {
  studying: { energyChange: -0.15, genres: ["lo-fi", "ambient", "classical"], keyword: "focus" },
  "walking-at-night": { energyChange: -0.05, genres: ["electronic", "ambient", "indie"], keyword: "night" },
  relaxing: { energyChange: -0.2, genres: ["ambient", "jazz", "lo-fi"], keyword: "relax" },
  driving: { energyChange: 0.15, genres: ["rock", "pop", "electronic"], keyword: "road trip" },
};

type SourceWeights = SearchCriteria["weights"];

/** Drops absent sources and rescales the rest to sum to 1. */
function rescaleWeights(hasPreferences: boolean, hasSituation: boolean): SourceWeights {
  const mood = SOURCE_WEIGHTS.mood;
  const preferences = hasPreferences ? SOURCE_WEIGHTS.preferences : 0;
  const situation = hasSituation ? SOURCE_WEIGHTS.situation : 0;
  const total = mood + preferences + situation;
  return { mood: mood / total, preferences: preferences / total, situation: situation / total };
}

function buildGenres(mood: MoodResult, preferences: Preferences, weights: SourceWeights): SearchCriteria["genres"] {
  const totals = new Map<Genre, number>();
  const add = (genres: readonly Genre[], weight: number) => {
    for (const genre of genres) totals.set(genre, (totals.get(genre) ?? 0) + weight / genres.length);
  };
  add(EMOTION_MAPPING[mood.primaryEmotion].genres, weights.mood);
  if (preferences.genres.length > 0) add(preferences.genres, weights.preferences);
  if (preferences.situation !== null) add(SITUATION_MAPPING[preferences.situation].genres, weights.situation);
  return [...totals]
    .map(([genre, weight]) => ({ genre, weight }))
    .sort((a, b) => b.weight - a.weight || (a.genre < b.genre ? -1 : a.genre > b.genre ? 1 : 0));
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function buildEnergy(mood: MoodResult, situation: Situation | null): number {
  const change = situation === null ? 0 : SITUATION_MAPPING[situation].energyChange;
  return clamp(EMOTION_MAPPING[mood.primaryEmotion].energy + change, 0, 1);
}

function buildTempo(mood: MoodResult, situation: Situation | null): SearchCriteria["tempo"] {
  const { minBpm, maxBpm } = EMOTION_MAPPING[mood.primaryEmotion];
  const shift = situation === null ? 0 : Math.round(SITUATION_MAPPING[situation].energyChange * 100);
  const max = clamp(maxBpm + shift, MIN_BPM + 1, MAX_BPM);
  const min = clamp(minBpm + shift, MIN_BPM, max - 1);
  return { minBpm: min, maxBpm: max };
}

/** Emotion keywords, then secondary moods, then the situation keyword; unique, at most MAX_KEYWORDS. */
function buildKeywords(mood: MoodResult, situation: Situation | null): string[] {
  const keywords: string[] = [...EMOTION_MAPPING[mood.primaryEmotion].keywords];
  const situationKeyword = situation === null ? null : SITUATION_MAPPING[situation].keyword;
  const room = MAX_KEYWORDS - (situationKeyword === null ? 0 : 1);
  for (const tag of mood.secondaryMoods) {
    const keyword = tag.trim().toLowerCase();
    if (keywords.length >= room) break;
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  if (situationKeyword !== null && !keywords.includes(situationKeyword)) keywords.push(situationKeyword);
  return keywords;
}

/**
 * Pure: no network, randomness, clock or environment. Trusts that its inputs satisfy
 * moodResultSchema and preferencesSchema.
 *
 * mood.confidence is deliberately ignored: the mood is already an interpretation, and a
 * low-confidence mood is corrected by the user, not guessed around here.
 */
export function buildSearchCriteria(mood: MoodResult, preferences: Preferences): SearchCriteria {
  const weights = rescaleWeights(preferences.genres.length > 0, preferences.situation !== null);
  return {
    genres: buildGenres(mood, preferences, weights),
    energy: buildEnergy(mood, preferences.situation),
    tempo: buildTempo(mood, preferences.situation),
    keywords: buildKeywords(mood, preferences.situation),
    artists: [...preferences.artists],
    languages: [...preferences.languages],
    weights,
  };
}
