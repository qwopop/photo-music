import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, getDb: vi.fn(() => { throw new Error("database must not be read"); }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie === undefined ? undefined : { value: mocks.cookie } }) }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));
afterEach(() => { mocks.cookie = undefined; vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("getCurrentUser request boundary", () => {
  it("starts with server-only", () => expect(readFileSync(new URL("./index.ts", import.meta.url), "utf8").split(/\r?\n/)[0]).toBe('import "server-only";'));
  it("imports without configuration or a database call", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(await import("./index")).toHaveProperty("getCurrentUser");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it.each([undefined, "malformed", "a".repeat(44)])("returns null without config for cookie %j", async (token) => {
    vi.stubEnv("DATABASE_URL", undefined);
    mocks.cookie = token;
    expect(await (await import("./index")).getCurrentUser()).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it("throws a database outage for a well-formed cookie", async () => {
    mocks.cookie = "a".repeat(43);
    await expect((await import("./index")).getCurrentUser()).rejects.toThrow("database must not be read");
    expect(mocks.getDb).toHaveBeenCalledOnce();
  });
});
