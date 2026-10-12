/**
 * Schemas and parsing for every environment variable the app reads.
 *
 * This file is plain TypeScript: it takes the environment as an argument and
 * imports nothing from Next.js or `server-only`, so tests and tools that run
 * outside Next.js can use it. App code imports `lib/config` instead, which
 * passes in `process.env` and is server-only.
 *
 * Every variable read here must also be listed in `.env.example`; a test
 * checks that the two agree.
 */
import { z } from "zod";

/** The environment to read variables from, such as `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface DatabaseConfig {
  url: string;
}

export interface VisionConfig {
  apiKey: string;
}

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
}

export interface YouTubeConfig {
  apiKey: string;
}

export interface StorageConfig {
  /** Unset for AWS S3; set for Cloudflare R2 or MinIO. */
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** One missing or invalid variable. Holds the reason, never the value. */
export interface ConfigProblem {
  variable: string;
  /** Such as "is missing" or "must be a postgres:// or postgresql:// URL". */
  reason: string;
}

/**
 * Thrown by a getter when any variable of its group is missing or invalid.
 * The message lists every problem variable of the group, and never contains
 * a variable's value.
 */
export class ConfigError extends Error {
  /** The group's name, such as "Spotify". */
  readonly group: string;
  readonly problems: readonly ConfigProblem[];

  constructor(group: string, problems: readonly ConfigProblem[]) {
    super(
      [
        `${group} configuration is missing or invalid:`,
        ...problems.map(({ variable, reason }) => `  - ${variable} ${reason}`),
        "Set these variables in .env.local for local development, or in the server's environment. " +
          "See .env.example for what each one is and where to get it.",
      ].join("\n"),
    );
    this.name = "ConfigError";
    this.group = group;
    this.problems = problems;
  }
}

const MISSING = "is missing";

/** Unset, empty and whitespace-only values count as missing; others are trimmed. */
function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * True if `value` is a URL whose scheme is one of `schemes` (such as
 * `"https:"`) and is followed by `//`, so `localhost:9000` does not pass.
 */
function isUrlWithScheme(value: string, schemes: readonly string[]): boolean {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return false;
  }
  return schemes.includes(protocol) && value.slice(protocol.length).startsWith("//");
}

function required() {
  return z.preprocess(normalize, z.string({ error: MISSING }));
}

function requiredUrl(schemes: readonly string[], format: string) {
  return z.preprocess(
    normalize,
    z.string({ error: MISSING }).refine((value) => isUrlWithScheme(value, schemes), { error: format }),
  );
}

function optionalUrl(schemes: readonly string[], format: string) {
  return z.preprocess(
    normalize,
    z
      .string()
      .refine((value) => isUrlWithScheme(value, schemes), { error: format })
      .optional(),
  );
}

const databaseSchema = z.object({
  DATABASE_URL: requiredUrl(["postgres:", "postgresql:"], "must be a postgres:// or postgresql:// URL"),
});

const visionSchema = z.object({
  VISION_API_KEY: required(),
});

const spotifySchema = z.object({
  SPOTIFY_CLIENT_ID: required(),
  SPOTIFY_CLIENT_SECRET: required(),
});

const youTubeSchema = z.object({
  YOUTUBE_API_KEY: required(),
});

const storageSchema = z.object({
  S3_ENDPOINT: optionalUrl(["http:", "https:"], "must be an http:// or https:// URL, or empty for AWS S3"),
  S3_REGION: required(),
  S3_BUCKET: required(),
  S3_ACCESS_KEY_ID: required(),
  S3_SECRET_ACCESS_KEY: required(),
});

/** Every variable the config module reads, in `.env.example` order. */
export const configVariableNames: readonly string[] = [
  databaseSchema,
  visionSchema,
  spotifySchema,
  youTubeSchema,
  storageSchema,
].flatMap((schema) => Object.keys(schema.shape));

/** Validates one group's variables, reporting all of its problems at once. */
function parseGroup<T extends z.ZodType>(group: string, schema: T, env: Env): z.output<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const problems: ConfigProblem[] = [];
  for (const issue of result.error.issues) {
    const variable = String(issue.path[0]);
    // Only messages set in this file are used, and none of them echo the input.
    if (!problems.some((problem) => problem.variable === variable)) {
      problems.push({ variable, reason: issue.message });
    }
  }
  throw new ConfigError(group, problems);
}

export function parseDatabaseConfig(env: Env): DatabaseConfig {
  const values = parseGroup("Database", databaseSchema, env);
  return { url: values.DATABASE_URL };
}

export function parseVisionConfig(env: Env): VisionConfig {
  const values = parseGroup("Vision", visionSchema, env);
  return { apiKey: values.VISION_API_KEY };
}

export function parseSpotifyConfig(env: Env): SpotifyConfig {
  const values = parseGroup("Spotify", spotifySchema, env);
  return { clientId: values.SPOTIFY_CLIENT_ID, clientSecret: values.SPOTIFY_CLIENT_SECRET };
}

export function parseYouTubeConfig(env: Env): YouTubeConfig {
  const values = parseGroup("YouTube", youTubeSchema, env);
  return { apiKey: values.YOUTUBE_API_KEY };
}

export function parseStorageConfig(env: Env): StorageConfig {
  const values = parseGroup("Storage", storageSchema, env);
  return {
    endpoint: values.S3_ENDPOINT,
    region: values.S3_REGION,
    bucket: values.S3_BUCKET,
    accessKeyId: values.S3_ACCESS_KEY_ID,
    secretAccessKey: values.S3_SECRET_ACCESS_KEY,
  };
}
