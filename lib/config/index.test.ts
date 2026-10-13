import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { configVariableNames } from "./schema";

// These tests import the real entry point, which reads `process.env`. Every
// config variable is removed before each test and only the ones a test needs
// are stubbed, so the variables set on the machine do not matter.

beforeEach(() => {
  for (const name of configVariableNames) {
    vi.stubEnv(name, undefined);
  }
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lib/config", () => {
  it("imports without throwing when no variables are set", async () => {
    const config = await import("./index");
    expect(Object.keys(config).sort()).toEqual([
      "ConfigError",
      "getClientIpConfig",
      "getDatabaseConfig",
      "getSpotifyConfig",
      "getStorageConfig",
      "getVisionConfig",
      "getYouTubeConfig",
    ]);
  });

  it("validates nothing until a getter is called, then throws a ConfigError", async () => {
    const config = await import("./index");
    for (const getter of [
      config.getDatabaseConfig,
      config.getVisionConfig,
      config.getSpotifyConfig,
      config.getYouTubeConfig,
      config.getStorageConfig,
    ]) {
      expect(getter).toThrow(config.ConfigError);
    }
    expect(config.getSpotifyConfig).toThrow(
      /^Spotify configuration is missing or invalid:\n {2}- SPOTIFY_CLIENT_ID is missing\n {2}- SPOTIFY_CLIENT_SECRET is missing\n/,
    );
  });

  it("reads process.env when a getter is called, not when the module is imported", async () => {
    const { getSpotifyConfig } = await import("./index");
    vi.stubEnv("SPOTIFY_CLIENT_ID", "  abc  ");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "def");
    expect(getSpotifyConfig()).toStrictEqual({ clientId: "abc", clientSecret: "def" });
  });

  it("checks only the group of the getter that is called", async () => {
    vi.stubEnv("SPOTIFY_CLIENT_ID", "abc");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "def");
    vi.stubEnv("DATABASE_URL", "not-a-url");
    const { ConfigError, getDatabaseConfig, getSpotifyConfig } = await import("./index");

    expect(getSpotifyConfig()).toStrictEqual({ clientId: "abc", clientSecret: "def" });
    expect(getDatabaseConfig).toThrow(ConfigError);
    expect(getDatabaseConfig).toThrow("DATABASE_URL must be a postgres:// or postgresql:// URL");
  });

  it("returns every group's settings when all variables are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/photo_music");
    vi.stubEnv("VISION_API_KEY", "vision-key");
    vi.stubEnv("YOUTUBE_API_KEY", "youtube-key");
    vi.stubEnv("S3_REGION", "auto");
    vi.stubEnv("S3_BUCKET", "photos");
    vi.stubEnv("S3_ACCESS_KEY_ID", "access-key-id");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret-access-key");
    const config = await import("./index");

    expect(config.getDatabaseConfig()).toStrictEqual({ url: "postgres://localhost/photo_music" });
    expect(config.getVisionConfig()).toStrictEqual({ apiKey: "vision-key" });
    expect(config.getYouTubeConfig()).toStrictEqual({ apiKey: "youtube-key" });
    expect(config.getStorageConfig()).toStrictEqual({
      endpoint: undefined,
      region: "auto",
      bucket: "photos",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
    });
  });

  // Checked by `npm run typecheck`; at run time these are no-ops.
  it("has typed return values", async () => {
    const config = await import("./index");

    expectTypeOf(config.getDatabaseConfig).returns.toEqualTypeOf<{ url: string }>();
    expectTypeOf(config.getVisionConfig).returns.toEqualTypeOf<{ apiKey: string }>();
    expectTypeOf(config.getSpotifyConfig).returns.toEqualTypeOf<{
      clientId: string;
      clientSecret: string;
    }>();
    expectTypeOf(config.getYouTubeConfig).returns.toEqualTypeOf<{ apiKey: string }>();
    expectTypeOf(config.getStorageConfig).returns.toEqualTypeOf<{
      endpoint: string | undefined;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    }>();

    const misspelled = () =>
      // @ts-expect-error -- SpotifyConfig has `clientSecret`, not `clientSecrt`.
      config.getSpotifyConfig().clientSecrt;
    expect(misspelled).toBeTypeOf("function");
  });
});
