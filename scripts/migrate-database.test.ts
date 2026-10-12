import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configVariableNames } from "../lib/config/schema";
import { freePort, startFakePostgres, type FakePostgres } from "./fake-postgres";
import { MIGRATIONS_FOLDER, migrateDatabase } from "./migrate-database";

// No test here needs a database server; the fake server stands in for the
// server-side failures. `npm run test:db` tests migrations against a real
// one (lib/db/migrate.db.test.ts). Each test sets DATABASE_URL itself, and
// every URL uses the password "leakcheck-pw", which must never appear in a
// message.

const PASSWORD = "leakcheck-pw";

function url(host: string, port: number): string {
  return `postgresql://photo_music:${PASSWORD}@${host}:${port}/photo_music`;
}

let server: FakePostgres | undefined;
let emptyFolder: string;

beforeAll(() => {
  emptyFolder = mkdtempSync(join(tmpdir(), "migrate-database-test-"));
});

afterAll(() => {
  rmSync(emptyFolder, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of configVariableNames) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

describe("migrateDatabase", () => {
  it("uses lib/db/migrations by default", () => {
    expect(MIGRATIONS_FOLDER.replace(/\\/g, "/")).toMatch(/\/lib\/db\/migrations$/);
  });

  describe("with DATABASE_URL unset, empty or invalid", () => {
    it.each([
      ["unset", undefined],
      ["empty", ""],
    ])("returns the ConfigError message when it is %s, without connecting", async (_, value) => {
      vi.stubEnv("DATABASE_URL", value);
      const connect = vi.spyOn(Client.prototype, "connect");

      const result = await migrateDatabase();

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^Database configuration is missing or invalid:\n {2}- DATABASE_URL is missing\n/);
      expect(connect).not.toHaveBeenCalled();
    });

    it("rejects a mysql:// URL with the ConfigError reason, without connecting", async () => {
      vi.stubEnv("DATABASE_URL", `mysql://photo_music:${PASSWORD}@localhost:54320/photo_music`);
      const connect = vi.spyOn(Client.prototype, "connect");

      const result = await migrateDatabase();

      expect(result).toStrictEqual({
        ok: false,
        message: expect.stringContaining("DATABASE_URL must be a postgres:// or postgresql:// URL"),
      });
      expect(result.message).not.toContain(PASSWORD);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  it.each(["127.0.0.1", "localhost"])(
    "gives db:check's message when nothing listens at %s",
    async (host) => {
      const port = await freePort();
      vi.stubEnv("DATABASE_URL", url(host, port));

      const result = await migrateDatabase();

      expect(result).toStrictEqual({
        ok: false,
        message:
          `Could not connect to PostgreSQL at ${host}:${port}: the connection was refused, so no server is listening there. ` +
          "Start the local database with `docker compose up -d --wait`, or check the host and port in DATABASE_URL.",
      });
    },
  );

  it("gives up after 10 seconds when the server never answers", async () => {
    server = await startFakePostgres("silent");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));
    // Only pg's connect timer is faked; sockets and setImmediate stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const pending = migrateDatabase().finally(() => (settled = true));
    for (let i = 0; server.connections === 0; i += 1) {
      if (i > 100_000) throw new Error("migrateDatabase() did not connect to the fake server");
      await new Promise((resolve) => setImmediate(resolve));
    }

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toStrictEqual({
      ok: false,
      message:
        `Could not connect to PostgreSQL at 127.0.0.1:${server.port}: the connection timed out after 10 seconds. ` +
        "Check the host and port in DATABASE_URL, and that the server is running and reachable from this computer.",
    });
  });

  it("reports the server's reason when the login fails", async () => {
    server = await startFakePostgres("wrong-password");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));

    const result = await migrateDatabase();

    expect(result).toStrictEqual({
      ok: false,
      message:
        `PostgreSQL at 127.0.0.1:${server.port} refused the connection: ` +
        'password authentication failed for user "photo_music" (SQLSTATE 28P01). ' +
        "Check the user and password in DATABASE_URL.",
    });
  });

  it("ignores PGSSLMODE, PGHOST and PGPASSWORD", async () => {
    // The fake server does not support TLS, so a TLS request would fail
    // with another message.
    server = await startFakePostgres("wrong-password");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));
    vi.stubEnv("PGSSLMODE", "require");
    vi.stubEnv("PGHOST", "192.0.2.1");
    vi.stubEnv("PGPASSWORD", "wrong");

    const result = await migrateDatabase();

    expect(result.message).toContain(`PostgreSQL at 127.0.0.1:${server.port} refused the connection: password authentication failed`);
    expect(server.connections).toBe(1);
  });

  it("explains a missing journal before connecting", async () => {
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", await freePort()));
    const connect = vi.spyOn(Client.prototype, "connect");

    const result = await migrateDatabase({ migrationsFolder: emptyFolder });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Could not read the migrations in .+: ENOENT/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("explains a journal entry without its SQL file", async () => {
    const folder = join(emptyFolder, "missing-sql");
    mkdirSync(join(folder, "meta"), { recursive: true });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ entries: [{ idx: 0, when: 1, tag: "0000_gone", breakpoints: true }] }),
    );
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", await freePort()));

    const result = await migrateDatabase({ migrationsFolder: folder });

    expect(result).toStrictEqual({
      ok: false,
      message: `Could not read the migrations in ${folder}: meta/_journal.json lists 0000_gone, but 0000_gone.sql does not exist.`,
    });
  });

  it("can take the database from its options instead of DATABASE_URL", async () => {
    const port = await freePort();

    const result = await migrateDatabase({ config: { url: url("127.0.0.1", port) } });

    expect(result.message).toContain(`127.0.0.1:${port}: the connection was refused`);
  });
});
