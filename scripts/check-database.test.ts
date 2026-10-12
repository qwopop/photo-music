import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configVariableNames } from "../lib/config/schema";
import { checkDatabase } from "./check-database";
import { FAKE_SERVER_VERSION, freePort, startFakePostgres, type FakePostgres } from "./fake-postgres";

// No test here needs a database server. Each one sets DATABASE_URL itself, so
// the variables set on the machine do not matter. Every URL uses the password
// "leakcheck-pw", which must never appear in a message.

const PASSWORD = "leakcheck-pw";

function url(host: string, port: number): string {
  return `postgresql://photo_music:${PASSWORD}@${host}:${port}/photo_music`;
}

/** Fails if `message` contains the password or the full URL. */
function expectNoSecrets(message: string, databaseUrl?: string): void {
  expect(message).not.toContain(PASSWORD);
  if (databaseUrl) expect(message).not.toContain(databaseUrl);
}

let server: FakePostgres | undefined;

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

describe("checkDatabase", () => {
  describe("with DATABASE_URL unset, empty or invalid", () => {
    it.each([
      ["unset", undefined],
      ["empty", ""],
    ])("returns the ConfigError message when it is %s, without connecting", async (_, value) => {
      vi.stubEnv("DATABASE_URL", value);
      const connect = vi.spyOn(Client.prototype, "connect");

      const result = await checkDatabase();

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^Database configuration is missing or invalid:\n {2}- DATABASE_URL is missing\n/);
      expect(result.message).toContain(".env.example");
      expect(connect).not.toHaveBeenCalled();
    });

    it("rejects a mysql:// URL with the ConfigError reason, without connecting", async () => {
      const mysqlUrl = `mysql://photo_music:${PASSWORD}@localhost:54320/photo_music`;
      vi.stubEnv("DATABASE_URL", mysqlUrl);
      const connect = vi.spyOn(Client.prototype, "connect");

      const result = await checkDatabase();

      expect(result.ok).toBe(false);
      expect(result.message).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
      expectNoSecrets(result.message, mysqlUrl);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  describe("when nothing listens at the host and port", () => {
    it.each(["127.0.0.1", "localhost"])("says so for %s, names the host and port, and how to start the database", async (host) => {
      // With "localhost", Node tries ::1 and 127.0.0.1 and reports an
      // AggregateError with an empty message.
      const port = await freePort();
      vi.stubEnv("DATABASE_URL", url(host, port));

      const result = await checkDatabase();

      expect(result).toStrictEqual({
        ok: false,
        message:
          `Could not connect to PostgreSQL at ${host}:${port}: the connection was refused, so no server is listening there. ` +
          "Start the local database with `docker compose up -d --wait`, or check the host and port in DATABASE_URL.",
      });
      expectNoSecrets(result.message, url(host, port));
    });
  });

  it("gives up after the connect timeout when the server never answers", async () => {
    server = await startFakePostgres("silent");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));

    const started = Date.now();
    const result = await checkDatabase({ connectTimeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.connections).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      `Could not connect to PostgreSQL at 127.0.0.1:${server.port}: the connection timed out after 0.3 seconds. ` +
        "Check the host and port in DATABASE_URL, and that the server is running and reachable from this computer.",
    );
    expectNoSecrets(result.message);
  });

  it("uses a 10-second connect timeout by default", async () => {
    server = await startFakePostgres("silent");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));
    // Only pg's connect timer is faked; sockets and setImmediate stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = checkDatabase();
    for (let i = 0; server.connections === 0; i += 1) {
      if (i > 100_000) throw new Error("checkDatabase() did not connect to the fake server");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(9_999);
    expect(server.open).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.message).toContain("the connection timed out after 10 seconds");
  });

  it("reports the server's reason when the login fails", async () => {
    server = await startFakePostgres("wrong-password");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));

    const result = await checkDatabase();

    expect(result).toStrictEqual({
      ok: false,
      message:
        `PostgreSQL at 127.0.0.1:${server.port} refused the connection: ` +
        'password authentication failed for user "photo_music" (SQLSTATE 28P01). ' +
        "Check the user and password in DATABASE_URL.",
    });
    expectNoSecrets(result.message, url("127.0.0.1", server.port));
  });

  it("explains the SQLSTATE when the server's message is not UTF-8", async () => {
    server = await startFakePostgres("wrong-password-cp1251");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));

    const result = await checkDatabase();

    expect(result).toStrictEqual({
      ok: false,
      message:
        `PostgreSQL at 127.0.0.1:${server.port} refused the connection: password authentication failed ` +
        "(SQLSTATE 28P01; the server's own message is not UTF-8 text, so it is not shown). " +
        "Check the user and password in DATABASE_URL.",
    });
  });

  it("prints the version, database and user on success, and closes the connection", async () => {
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));

    const result = await checkDatabase();

    expect(result).toStrictEqual({
      ok: true,
      message: `Connected to PostgreSQL ${FAKE_SERVER_VERSION} at 127.0.0.1:${server.port}, database "photo_music", user "photo_music".`,
    });
    expect(result.message).not.toContain("\n");
    expectNoSecrets(result.message, url("127.0.0.1", server.port));
    expect(server.terminated).toBe(1);
    await vi.waitFor(() => expect(server?.open).toBe(0));
  });

  it("hides the password even if a message would contain it", async () => {
    // A user name equal to the password shows up in the success line.
    server = await startFakePostgres("ok");
    vi.stubEnv("DATABASE_URL", `postgresql://photo_music:photo_music@127.0.0.1:${server.port}/photo_music`);

    const result = await checkDatabase();

    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("photo_music");
    expect(result.message).toContain('database "[hidden]", user "[hidden]"');
  });
});
