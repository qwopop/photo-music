import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configVariableNames,
  parseClientIpConfig,
  parseDatabaseConfig,
  parseSpotifyConfig,
  parseStorageConfig,
  parseVisionConfig,
  parseYouTubeConfig,
  type Env,
} from "./schema";

// Every test passes its own env object, so nothing here depends on the
// variables set on the machine running the tests.

const validEnv = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/photo_music",
  VISION_API_KEY: "vision-key",
  SPOTIFY_CLIENT_ID: "spotify-id",
  SPOTIFY_CLIENT_SECRET: "spotify-secret",
  YOUTUBE_API_KEY: "youtube-key",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "photos",
  S3_ACCESS_KEY_ID: "access-key-id",
  S3_SECRET_ACCESS_KEY: "secret-access-key",
} as const satisfies Env;

/** Calls `parse`, expects a ConfigError, and returns it. */
function configError(parse: (env: Env) => unknown, env: Env): ConfigError {
  try {
    parse(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError, but parsing succeeded");
}

const groups = [
  {
    group: "Database",
    parse: parseDatabaseConfig,
    variables: ["DATABASE_URL"],
    required: ["DATABASE_URL"],
    fields: ["url"],
  },
  {
    group: "Vision",
    parse: parseVisionConfig,
    variables: ["VISION_API_KEY"],
    required: ["VISION_API_KEY"],
    fields: ["apiKey"],
  },
  {
    group: "Spotify",
    parse: parseSpotifyConfig,
    variables: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    required: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    fields: ["clientId", "clientSecret"],
  },
  {
    group: "YouTube",
    parse: parseYouTubeConfig,
    variables: ["YOUTUBE_API_KEY"],
    required: ["YOUTUBE_API_KEY"],
    fields: ["apiKey"],
  },
  {
    group: "Storage",
    parse: parseStorageConfig,
    variables: ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    required: ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    fields: ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"],
  },
];

describe("configVariableNames", () => {
  it("lists every variable of every group once", () => {
    expect(configVariableNames).toEqual([...groups.flatMap(({ variables }) => variables), "CLIENT_IP_HEADER"]);
    expect(new Set(configVariableNames).size).toBe(configVariableNames.length);
  });

  it("has no NEXT_PUBLIC_ variables, because every setting is server-only", () => {
    expect(configVariableNames.filter((name) => name.startsWith("NEXT_PUBLIC_"))).toEqual([]);
  });
});

describe("valid configuration", () => {
  it("returns exactly the fields of each group", () => {
    expect(parseDatabaseConfig(validEnv)).toStrictEqual({ url: validEnv.DATABASE_URL });
    expect(parseVisionConfig(validEnv)).toStrictEqual({ apiKey: "vision-key" });
    expect(parseSpotifyConfig(validEnv)).toStrictEqual({
      clientId: "spotify-id",
      clientSecret: "spotify-secret",
    });
    expect(parseYouTubeConfig(validEnv)).toStrictEqual({ apiKey: "youtube-key" });
    expect(parseStorageConfig(validEnv)).toStrictEqual({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "photos",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(
      parseSpotifyConfig({ SPOTIFY_CLIENT_ID: "  abc  ", SPOTIFY_CLIENT_SECRET: "\tdef\n" }),
    ).toStrictEqual({ clientId: "abc", clientSecret: "def" });
    expect(parseDatabaseConfig({ DATABASE_URL: "  postgres://localhost/db \r\n" })).toStrictEqual({
      url: "postgres://localhost/db",
    });
    expect(parseStorageConfig({ ...validEnv, S3_ENDPOINT: " https://example.com ", S3_BUCKET: " b " }))
      .toMatchObject({ endpoint: "https://example.com", bucket: "b" });
  });

  it("keeps whitespace inside a value", () => {
    expect(parseVisionConfig({ VISION_API_KEY: " a b " })).toStrictEqual({ apiKey: "a b" });
  });
});

describe.each(groups)("$group group", ({ group, parse, variables, required, fields }) => {
  const groupEnv: Env = Object.fromEntries(
    variables.map((name) => [name, validEnv[name as keyof typeof validEnv]]),
  );

  it("succeeds with only its own variables set", () => {
    expect(Object.keys(parse(groupEnv) as object).sort()).toEqual([...fields].sort());
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only whitespace", " \t "],
  ])("reports a required variable as missing when it is %s", (_, value) => {
    for (const name of required) {
      const error = configError(parse, { ...groupEnv, [name]: value });
      expect(error.problems).toEqual([{ variable: name, reason: "is missing" }]);
      expect(error.message).toContain(`${name} is missing`);
    }
  });

  it("lists every missing variable of the group at once", () => {
    const error = configError(parse, {});
    expect(error.problems.map(({ variable }) => variable)).toEqual(required);
    for (const name of required) {
      expect(error.message).toContain(`${name} is missing`);
    }
  });

  it("names the group and mentions .env.example", () => {
    const error = configError(parse, {});
    expect(error.name).toBe("ConfigError");
    expect(error.group).toBe(group);
    expect(error.message).toMatch(new RegExp(`^${group} configuration is missing or invalid:`));
    expect(error.message).toContain(".env.example");
  });

  it("ignores every other group's variables, valid or not", () => {
    const otherNames = configVariableNames.filter((name) => !variables.includes(name));
    const brokenOthers = Object.fromEntries(otherNames.map((name) => [name, "not-a-url"]));
    expect(() => parse({ ...groupEnv, ...brokenOthers })).not.toThrow();

    const error = configError(parse, brokenOthers);
    expect(error.problems.map(({ variable }) => variable)).toEqual(required);
    for (const name of otherNames) {
      expect(error.message).not.toContain(name);
    }
  });
});

describe("Database URL", () => {
  it.each([
    "postgres://app:secret@localhost:5432/photo_music",
    "postgresql://app:secret@localhost:5432/photo_music",
    "postgresql://localhost/photo_music?sslmode=require",
    "POSTGRES://localhost/photo_music",
    "postgresql:///photo_music",
  ])("accepts %s", (url) => {
    expect(parseDatabaseConfig({ DATABASE_URL: url })).toStrictEqual({ url });
  });

  it.each([
    "not-a-url",
    "localhost:5432/photo_music",
    "mysql://app:secret@localhost/db",
    "http://localhost:5432/photo_music",
    "postgres:photo_music",
    "postgres//localhost/photo_music",
  ])("rejects %s", (url) => {
    const error = configError(parseDatabaseConfig, { DATABASE_URL: url });
    expect(error.problems).toEqual([
      { variable: "DATABASE_URL", reason: "must be a postgres:// or postgresql:// URL" },
    ]);
    expect(error.message).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
  });
});

describe("S3 endpoint", () => {
  const withoutEndpoint: Env = Object.fromEntries(
    Object.entries(validEnv).filter(([name]) => name !== "S3_ENDPOINT"),
  );

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only whitespace", "  "],
  ])("is optional, and %s gives endpoint: undefined", (_, value) => {
    const config = parseStorageConfig({ ...withoutEndpoint, S3_ENDPOINT: value });
    expect(config).toHaveProperty("endpoint", undefined);
    expect(config.endpoint).toBeUndefined();
  });

  it("is optional even when it is not in the env object at all", () => {
    expect(parseStorageConfig(withoutEndpoint)).toStrictEqual({
      endpoint: undefined,
      region: "us-east-1",
      bucket: "photos",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
    });
  });

  it.each([
    "http://localhost:9000",
    "https://0123456789abcdef.r2.cloudflarestorage.com",
    "HTTPS://s3.example.com",
  ])("accepts %s", (endpoint) => {
    expect(parseStorageConfig({ ...validEnv, S3_ENDPOINT: endpoint }).endpoint).toBe(endpoint);
  });

  it.each(["localhost:9000", "ftp://files.example.com", "not a url", "http:localhost:9000", "https://"])(
    "rejects %s",
    (endpoint) => {
      const error = configError(parseStorageConfig, { ...validEnv, S3_ENDPOINT: endpoint });
      expect(error.problems).toEqual([
        { variable: "S3_ENDPOINT", reason: "must be an http:// or https:// URL, or empty for AWS S3" },
      ]);
    },
  );

  it("is listed together with missing required variables", () => {
    const error = configError(parseStorageConfig, { S3_ENDPOINT: "localhost:9000", S3_REGION: "auto" });
    expect(error.problems).toEqual([
      { variable: "S3_ENDPOINT", reason: "must be an http:// or https:// URL, or empty for AWS S3" },
      { variable: "S3_BUCKET", reason: "is missing" },
      { variable: "S3_ACCESS_KEY_ID", reason: "is missing" },
      { variable: "S3_SECRET_ACCESS_KEY", reason: "is missing" },
    ]);
  });
});

describe("independent groups", () => {
  it("validates only the group that is asked for", () => {
    const env = {
      SPOTIFY_CLIENT_ID: "abc",
      SPOTIFY_CLIENT_SECRET: "def",
      DATABASE_URL: "not-a-url",
    };
    expect(parseSpotifyConfig(env)).toStrictEqual({ clientId: "abc", clientSecret: "def" });
    expect(() => parseDatabaseConfig(env)).toThrow(ConfigError);
  });
});

describe("error messages never contain values", () => {
  it("does not leak the password or the URL of an invalid DATABASE_URL", () => {
    const url = "mysql://app:hunter2@localhost/db";
    const error = configError(parseDatabaseConfig, { DATABASE_URL: url });
    expect(error.message).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
    for (const text of [error.message, String(error), error.stack ?? "", JSON.stringify(error.problems)]) {
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain(url);
      expect(text).not.toContain("mysql");
    }
  });

  it("does not leak any value set in a failing group", () => {
    const env: Env = {
      S3_ENDPOINT: "leakcheck-endpoint",
      S3_REGION: "leakcheck-region",
      S3_BUCKET: "leakcheck-bucket",
      S3_ACCESS_KEY_ID: "leakcheck-access-key-id",
      S3_SECRET_ACCESS_KEY: "",
    };
    const error = configError(parseStorageConfig, env);
    expect(error.problems.map(({ variable }) => variable)).toEqual(["S3_ENDPOINT", "S3_SECRET_ACCESS_KEY"]);
    expect(`${error.message}\n${error.stack}\n${JSON.stringify(error.problems)}`).not.toContain("leakcheck");
  });
});

describe("parseClientIpConfig", () => {
  it("defaults to x-vercel-forwarded-for", () => {
    expect(parseClientIpConfig({})).toStrictEqual({ header: "x-vercel-forwarded-for" });
    expect(parseClientIpConfig({ CLIENT_IP_HEADER: "  " })).toStrictEqual({ header: "x-vercel-forwarded-for" });
  });
  it("trims and lower-cases a configured header", () => {
    expect(parseClientIpConfig({ CLIENT_IP_HEADER: " CF-Connecting-IP " })).toStrictEqual({ header: "cf-connecting-ip" });
  });
  it("rejects something that is not a header name without echoing it", () => {
    expect(() => parseClientIpConfig({ CLIENT_IP_HEADER: "bad header!" })).toThrow(/CLIENT_IP_HEADER must be an HTTP header name/);
  });
});
