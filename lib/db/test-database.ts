/**
 * The Vitest global setup of `npm run test:db` (vitest.db.config.mts), and
 * helpers for the `*.db.test.ts` tests.
 *
 * Each run:
 *
 * 1. reads `DATABASE_URL` through `lib/config/node`, and refuses any host
 *    other than `localhost`, `127.0.0.1` or `::1` before connecting;
 * 2. creates a new database named `photo_music_test_` plus a random suffix
 *    on that server, which needs the `CREATEDB` privilege;
 * 3. applies the committed migrations to it with the code behind
 *    `npm run db:migrate`;
 * 4. hands its URL to the tests (`inject("testDatabaseUrl")`);
 * 5. drops it at the end with `DROP DATABASE ... WITH (FORCE)`, also when a
 *    test fails, together with any database a test created from it.
 *
 * It never touches the `DATABASE_URL` database itself, and never prints a
 * URL. When it cannot test, it fails with a short message instead of
 * skipping.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { describeConnectError, formatAddress, redact, secretsOf, serverReason } from "../../scripts/database-errors";
import { migrateDatabase } from "../../scripts/migrate-database";
import { getDatabaseConfig } from "../config/node";
import { ConfigError } from "../config/schema";
import { CONNECT_TIMEOUT_MS, connectionSettings } from "./connection";

declare module "vitest" {
  export interface ProvidedContext {
    /** The URL of this run's throwaway database. Never print it. */
    testDatabaseUrl: string;
  }
}

/** Every database that `npm run test:db` creates starts with this. */
export const TEST_DATABASE_PREFIX = "photo_music_test_";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/** A reason why the tests cannot run, as a short message for the developer. */
class TestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseError";
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    return await prepare(project);
  } catch (error) {
    if (!(error instanceof TestDatabaseError)) throw error;
    // Thrown from here, Vitest would print the error with a stack trace,
    // after a misleading "No test files found". Print only the reason, and
    // exit once it is written.
    await new Promise<void>((resolve) => process.stderr.write(`${error.message}\n`, () => resolve()));
    process.exit(1);
  }
}

/** Steps 1 to 4. Returns the teardown, which is step 5. */
async function prepare(project: TestProject): Promise<() => Promise<void>> {
  let url: string;
  try {
    ({ url } = getDatabaseConfig());
  } catch (error) {
    if (error instanceof ConfigError) throw new TestDatabaseError(error.message);
    throw new TestDatabaseError("Could not read DATABASE_URL.");
  }
  assertLocalServer(url);

  const name = `${TEST_DATABASE_PREFIX}${randomBytes(6).toString("hex")}`;
  await withClient(url, async (client, hide) => {
    try {
      await client.query(`create database ${quoteIdentifier(name)}`);
    } catch (error) {
      throw new TestDatabaseError(hide(describeCreateError(error, client.user)));
    }
  });

  const testUrl = databaseUrl(url, name);
  try {
    const result = await migrateDatabase({ config: { url: testUrl } });
    if (!result.ok) {
      throw new TestDatabaseError(`Could not apply the migrations to the test database: ${result.message}`);
    }
  } catch (error) {
    await dropDatabases(url, name);
    throw error;
  }

  project.provide("testDatabaseUrl", testUrl);
  return () => dropDatabases(url, name);
}

/**
 * Throws unless `url` points to a server on this computer, as read by
 * `new URL()` and by `pg` (which also reads a `host` parameter in the URL).
 * It connects to nothing.
 */
export function assertLocalServer(url: string): void {
  let urlHost: string;
  let pgHost: string;
  let password: unknown;
  try {
    urlHost = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
    const client = new Client(connectionSettings({ url }));
    pgHost = client.host;
    password = client.password;
  } catch {
    throw new TestDatabaseError("The PostgreSQL driver could not read DATABASE_URL.");
  }
  for (const host of [urlHost, pgHost]) {
    if (!LOCAL_HOSTS.has(host.toLowerCase())) {
      throw new TestDatabaseError(
        redact(
          `npm run test:db runs only against a PostgreSQL server on this computer, because it creates and drops databases there. ` +
            `The host in DATABASE_URL is ${host === "" ? "empty" : `"${host}"`}. ` +
            "Point DATABASE_URL at localhost, 127.0.0.1 or ::1, such as the local database from `docker compose up -d --wait`.",
          secretsOf(url, password),
        ),
      );
    }
  }
}

/** `url` with its database name swapped for `name`. */
export function databaseUrl(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

/** The database name in `url`. */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/**
 * Creates an empty database next to this run's test database, for a test
 * that needs one, and returns its URL. Its name starts with the test
 * database's name, so the global teardown drops it if the test does not.
 */
export async function createScratchDatabase(testUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `${databaseName(testUrl)}_${randomBytes(4).toString("hex")}`;
  await withClient(testUrl, (client) => client.query(`create database ${quoteIdentifier(name)}`));
  return {
    url: databaseUrl(testUrl, name),
    drop: () =>
      withClient(testUrl, async (client) => {
        await client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
      }),
  };
}

/** Drops the database `name` and every database whose name starts with it. */
async function dropDatabases(url: string, name: string): Promise<void> {
  await withClient(url, async (client, hide) => {
    try {
      const { rows } = await client.query<{ datname: string }>(
        "select datname from pg_database where starts_with(datname, $1) order by datname",
        [name],
      );
      for (const { datname } of rows) {
        await client.query(`drop database if exists ${quoteIdentifier(datname)} with (force)`);
      }
    } catch (error) {
      throw new TestDatabaseError(
        hide(`Could not drop the test database ${name}: ${serverReason(error)}. Drop it by hand (see the README).`),
      );
    }
  });
}

/**
 * Connects to `url`, runs `work`, and always disconnects. A connection
 * failure throws the same message as `npm run db:check`. `hide` redacts a
 * message.
 */
async function withClient<T>(
  url: string,
  work: (client: Client, hide: (message: string) => string) => Promise<T>,
): Promise<T> {
  const client = new Client(connectionSettings({ url }));
  const secrets = secretsOf(url, client.password);
  const hide = (message: string) => redact(message, secrets);
  client.on("error", () => {});
  try {
    try {
      await client.connect();
    } catch (error) {
      const where = formatAddress(client.host, client.port);
      throw new TestDatabaseError(hide(describeConnectError(error, where, CONNECT_TIMEOUT_MS)));
    }
    return await work(client, hide);
  } finally {
    await client.end().catch(() => {});
  }
}

function describeCreateError(error: unknown, user: string | undefined): string {
  // 42501: insufficient_privilege.
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42501") {
    return (
      `The user${user ? ` "${user}"` : ""} in DATABASE_URL needs the CREATEDB privilege, because npm run test:db creates a throwaway database for each run and drops it at the end. ` +
      `The server said: ${serverReason(error)}. ` +
      `A superuser can grant it with: ALTER ROLE ${user ? quoteIdentifier(user) : "<user>"} CREATEDB;`
    );
  }
  return `Could not create the test database: ${serverReason(error)}`;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
