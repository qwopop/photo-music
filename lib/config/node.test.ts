import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { configVariableNames } from "./schema";

// Like index.test.ts: every config variable is removed before each test and
// only the ones a test needs are stubbed, so the machine's variables do not
// matter.

beforeEach(() => {
  for (const name of configVariableNames) {
    vi.stubEnv(name, undefined);
  }
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lib/config/node", () => {
  it("exports only the database getter", async () => {
    const config = await import("./node");
    expect(Object.keys(config)).toEqual(["getDatabaseConfig"]);
  });

  it("does not import server-only, so it works outside Next.js", () => {
    const source = readFileSync(new URL("./node.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s+["']server-only["']/m);
    expect(source).not.toMatch(/from\s+["']\.\/index["']|from\s+["']\.["']/);
  });

  it("reads DATABASE_URL from process.env when the getter is called", async () => {
    const { getDatabaseConfig } = await import("./node");
    vi.stubEnv("DATABASE_URL", "  postgresql://app:secret@localhost:54320/photo_music  ");
    expect(getDatabaseConfig()).toStrictEqual({
      url: "postgresql://app:secret@localhost:54320/photo_music",
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("throws the lib/config ConfigError when DATABASE_URL is %s", async (_, value) => {
    vi.stubEnv("DATABASE_URL", value);
    const { getDatabaseConfig } = await import("./node");
    // After vi.resetModules(), ConfigError must come from the same fresh module graph.
    const { ConfigError } = await import("./schema");
    expect(getDatabaseConfig).toThrow(ConfigError);
    expect(getDatabaseConfig).toThrow(
      /^Database configuration is missing or invalid:\n {2}- DATABASE_URL is missing\n[\s\S]*\.env\.example/,
    );
  });

  it("rejects a URL that is not postgres:// or postgresql://, without echoing it", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://photo_music:leakcheck-pw@localhost:54320/photo_music");
    const { getDatabaseConfig } = await import("./node");
    expect(getDatabaseConfig).toThrow("DATABASE_URL must be a postgres:// or postgresql:// URL");
    expect(getDatabaseConfig).not.toThrow(/leakcheck-pw/);
  });

  it("ignores the other groups' variables", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/photo_music");
    vi.stubEnv("S3_ENDPOINT", "not-a-url");
    const { getDatabaseConfig } = await import("./node");
    expect(getDatabaseConfig()).toStrictEqual({ url: "postgres://localhost/photo_music" });
  });

  // Checked by `npm run typecheck`; at run time these are no-ops.
  it("has a typed return value", async () => {
    const { getDatabaseConfig } = await import("./node");
    expectTypeOf(getDatabaseConfig).returns.toEqualTypeOf<{ url: string }>();
  });
});
