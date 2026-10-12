/**
 * The app's settings, read from environment variables. Server-only.
 *
 * Each getter validates only its own group, when it is called, and throws a
 * `ConfigError` naming every missing or invalid variable of that group.
 * Importing this module never throws, so build and tests need no variables.
 *
 * Call the getters only while handling a request (see the Rules in
 * AGENTS.md), and never log what they return.
 */
import "server-only";

import {
  parseDatabaseConfig,
  parseSpotifyConfig,
  parseStorageConfig,
  parseVisionConfig,
  parseYouTubeConfig,
  type DatabaseConfig,
  type SpotifyConfig,
  type StorageConfig,
  type VisionConfig,
  type YouTubeConfig,
} from "./schema";

export { ConfigError } from "./schema";
export type {
  ConfigProblem,
  DatabaseConfig,
  SpotifyConfig,
  StorageConfig,
  VisionConfig,
  YouTubeConfig,
} from "./schema";

/** `DATABASE_URL`. */
export function getDatabaseConfig(): DatabaseConfig {
  return parseDatabaseConfig(process.env);
}

/** `VISION_API_KEY`. */
export function getVisionConfig(): VisionConfig {
  return parseVisionConfig(process.env);
}

/** `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. */
export function getSpotifyConfig(): SpotifyConfig {
  return parseSpotifyConfig(process.env);
}

/** `YOUTUBE_API_KEY`. */
export function getYouTubeConfig(): YouTubeConfig {
  return parseYouTubeConfig(process.env);
}

/** `S3_ENDPOINT` (optional), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. */
export function getStorageConfig(): StorageConfig {
  return parseStorageConfig(process.env);
}
