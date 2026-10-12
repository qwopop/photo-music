import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_SERVER_VERSION, startFakePostgres, type FakePostgres } from "../../scripts/fake-postgres";
import { configVariableNames } from "../config/schema";

// No test here needs a database server: the fake server from scripts/ stands
// in for one. Every config variable is removed before each test and only the
// ones a test needs are stubbed, so the variables set on the machine do not
// matter. Each test starts with fresh modules and no client on globalThis.

const PASSWORD = "leakcheck-pw";

function url(port: number): string {
  return `postgresql://photo_music:${PASSWORD}@127.0.0.1:${port}/photo_music`;
}

let server: FakePostgres | undefined;

beforeEach(() => {
  for (const name of configVariableNames) {
    vi.stubEnv(name, undefined);
  }
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  const { closeDb } = await import("./index");
  await closeDb();
  vi.doUnmock("../config");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

describe("lib/db", () => {
  it("starts with import \"server-only\"", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const firstStatement = source.replace(/\/\*[\s\S]*?\*\//g, "").trim().split(/\r?\n/)[0];
    expect(firstStatement).toBe('import "server-only";');
  });

  it("reads no variable and opens no connection when imported", async () => {
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", url(server.port));
    const getDatabaseConfig = vi.fn();
    vi.doMock("../config", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../config")>();
      getDatabaseConfig.mockImplementation(actual.getDatabaseConfig);
      return { ...actual, getDatabaseConfig };
    });

    const db = await import("./index");

    expect(Object.keys(db).sort()).toEqual(["closeDb", "getDb"]);
    expect(getDatabaseConfig).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.connections).toBe(0);

    // getDb() reads the config, and the pool connects on the first query.
    db.getDb();
    expect(getDatabaseConfig).toHaveBeenCalledTimes(1);
    expect(server.connections).toBe(0);
  });

  it("imports without throwing when no variables are set", async () => {
    await expect(import("./index")).resolves.toHaveProperty("getDb");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("getDb() throws the lib/config ConfigError when DATABASE_URL is %s", async (_, value) => {
    vi.stubEnv("DATABASE_URL", value);
    const { getDb } = await import("./index");
    // After vi.resetModules(), ConfigError must come from the same fresh module graph.
    const { ConfigError } = await import("../config");

    expect(getDb).toThrow(ConfigError);
    expect(getDb).toThrow(/^Database configuration is missing or invalid:\n {2}- DATABASE_URL is missing\n/);
  });

  it("getDb() throws the ConfigError for a URL that is not postgres://, without echoing it", async () => {
    vi.stubEnv("DATABASE_URL", `mysql://photo_music:${PASSWORD}@127.0.0.1:3306/photo_music`);
    const { getDb } = await import("./index");

    expect(getDb).toThrow("DATABASE_URL must be a postgres:// or postgresql:// URL");
    expect(getDb).not.toThrow(new RegExp(PASSWORD));
  });

  it("returns the same client every time, also after the module is evaluated again", async () => {
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", url(server.port));
    const first = (await import("./index")).getDb();
    expect((await import("./index")).getDb()).toBe(first);

    // As hot reload in `npm run dev` does.
    vi.resetModules();
    const reloaded = await import("./index");
    const second = reloaded.getDb();

    expect(second).toBe(first);
    expect(second.$client).toBe(first.$client);
  });

  it("queries the server in DATABASE_URL", async () => {
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", url(server.port));
    const { getDb } = await import("./index");

    const result = await getDb().execute<{ server_version: string }>(sql`select 1`);

    expect(result.rows[0].server_version).toBe(FAKE_SERVER_VERSION);
    expect(server.connections).toBe(1);
  });

  it("ignores PGSSLMODE, PGHOST and PGPASSWORD, and uses no TLS unless the URL asks for it", async () => {
    // The fake server does not support TLS: a TLS request would fail. It
    // accepts any password; connection.test.ts checks which one pg sends.
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", url(server.port));
    vi.stubEnv("PGSSLMODE", "require");
    vi.stubEnv("PGHOST", "192.0.2.1");
    vi.stubEnv("PGPASSWORD", "wrong");
    const { getDb } = await import("./index");

    const result = await getDb().execute<{ server_version: string }>(sql`select 1`);

    expect(result.rows[0].server_version).toBe(FAKE_SERVER_VERSION);
    expect(server.connections).toBe(1);
  });

  it("asks for TLS when the URL has sslmode", async () => {
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", `${url(server.port)}?sslmode=no-verify`);
    const { getDb } = await import("./index");

    await expect(getDb().execute(sql`select 1`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/SSL/) }),
    });
  });

  it("fails a query after 10 seconds when the server never answers", async () => {
    server = await startFakePostgres("silent");
    vi.stubEnv("DATABASE_URL", url(server.port));
    const { getDb } = await import("./index");
    // Only pg's connect timers are faked; sockets and setImmediate stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let settled = false;
    const pending = getDb()
      .execute(sql`select 1`)
      .finally(() => (settled = true));
    pending.catch(() => {});
    for (let i = 0; server.connections === 0; i += 1) {
      if (i > 100_000) throw new Error("getDb() did not connect to the fake server");
      await new Promise((resolve) => setImmediate(resolve));
    }

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    expect(server.open).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/timeout/i) }),
    });
  });

  it("closeDb() closes the pool, and the next getDb() creates a new client", async () => {
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", url(server.port));
    const { closeDb, getDb } = await import("./index");
    const first = getDb();
    await first.execute(sql`select 1`);

    await closeDb();

    expect(first.$client.ended).toBe(true);
    await vi.waitFor(() => expect(server?.open).toBe(0));
    expect(getDb()).not.toBe(first);
  });
});
