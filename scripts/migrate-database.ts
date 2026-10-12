/**
 * The migration runner behind `npm run db:migrate` (see `db-migrate.ts`).
 * `npm run test:db` migrates its throwaway database with it too.
 *
 * It applies the pending migrations in `lib/db/migrations` with Drizzle's
 * `migrate()`, which runs all of them in one transaction and records each one
 * in the history table `drizzle.__drizzle_migrations`. Before that, it
 * refuses to run when the folder has a migration that the database has not
 * applied but that is older than the newest one it has: Drizzle would skip
 * such a migration for good.
 *
 * Migrations are matched to history rows by their journal timestamp (`when`
 * in `meta/_journal.json`), as Drizzle itself does, not by the file hash:
 * a Windows checkout with CRLF line endings hashes differently from a Linux
 * one.
 *
 * It never throws. Every outcome is a short result, and no result contains
 * the password or the full `DATABASE_URL`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DrizzleQueryError, type Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { getDatabaseConfig } from "../lib/config/node";
import { ConfigError, type DatabaseConfig } from "../lib/config/schema";
import { CONNECT_TIMEOUT_MS, connectionSettings } from "../lib/db/connection";
import { describeConnectError, formatAddress, messageOf, redact, secretsOf, serverReason } from "./database-errors";

/** The committed migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../lib/db/migrations", import.meta.url));

/** Drizzle's default history table, which `migrate()` creates and fills. */
const HISTORY_SCHEMA = "drizzle";
const HISTORY_TABLE = "__drizzle_migrations";

export interface MigrateDatabaseOptions {
  /** The database to migrate. Defaults to `DATABASE_URL`, read through `lib/config/node`. */
  config?: DatabaseConfig;
  /** Defaults to `lib/db/migrations`. */
  migrationsFolder?: string;
}

export type MigrateDatabaseResult =
  | {
      ok: true;
      /** The tags of the migrations applied by this run, oldest first. */
      applied: string[];
      /** One or more lines for stdout. */
      message: string;
    }
  | { ok: false; message: string };

/** One entry of `meta/_journal.json`. */
interface JournalEntry {
  /** The migration's name, which is also its file name without `.sql`. */
  tag: string;
  /** When it was generated, in milliseconds. Drizzle stores it as `created_at`. */
  when: number;
}

export async function migrateDatabase(options: MigrateDatabaseOptions = {}): Promise<MigrateDatabaseResult> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;

  let url: string;
  try {
    ({ url } = options.config ?? getDatabaseConfig());
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, message: error.message };
    return { ok: false, message: "Could not read DATABASE_URL." };
  }

  let journal: JournalEntry[];
  try {
    journal = readJournal(migrationsFolder);
  } catch (error) {
    return { ok: false, message: `Could not read the migrations in ${migrationsFolder}: ${messageOf(error)}` };
  }

  let secrets = [url];
  let client: Client;
  try {
    client = new Client(connectionSettings({ url }));
  } catch (error) {
    return failure(`The PostgreSQL driver could not use DATABASE_URL: ${messageOf(error)}`, secrets);
  }
  secrets = secretsOf(url, client.password);
  // An error after the connection is up (such as the server closing it)
  // would otherwise crash the process with a stack trace. The pending query
  // rejects with it instead.
  client.on("error", () => {});

  const where = formatAddress(client.host, client.port);
  try {
    try {
      await client.connect();
    } catch (error) {
      return failure(describeConnectError(error, where, CONNECT_TIMEOUT_MS), secrets);
    }

    let applied: number[];
    try {
      applied = await appliedTimestamps(client);
    } catch (error) {
      return failure(
        `Could not read the migration history in ${HISTORY_SCHEMA}.${HISTORY_TABLE} at ${where}: ${serverReason(error)}`,
        secrets,
      );
    }

    // The same rule as Drizzle's migrate(): it applies exactly the
    // migrations that are newer than the newest one in the history table.
    const newest = applied.length > 0 ? Math.max(...applied) : undefined;
    const pending = journal.filter((entry) => newest === undefined || entry.when > newest);
    const skipped = journal.filter((entry) => newest !== undefined && entry.when <= newest && !applied.includes(entry.when));

    if (skipped.length > 0) {
      return failure(describeSkipped(skipped, journal, newest as number), secrets);
    }
    if (pending.length === 0) {
      return {
        ok: true,
        applied: [],
        message: redact(`The database at ${where} is already up to date: there are no migrations to apply.`, secrets),
      };
    }

    const progress = new MigrationProgress();
    try {
      await migrate(drizzle({ client, logger: progress }), { migrationsFolder });
    } catch (error) {
      return failure(describeMigrateError(error, pending, progress, where), secrets);
    }

    const count = pending.length === 1 ? "1 migration" : `${pending.length} migrations`;
    return {
      ok: true,
      applied: pending.map((entry) => entry.tag),
      message: redact(
        [...pending.map((entry) => `Applied ${entry.tag}`), `Applied ${count} to the database at ${where}.`].join("\n"),
        secrets,
      ),
    };
  } finally {
    // Resolves at once if the connection never opened or is already closed.
    await client.end().catch(() => {});
  }
}

/** The migrations listed in `meta/_journal.json`, in journal order. */
function readJournal(migrationsFolder: string): JournalEntry[] {
  const journal: unknown = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const entries = (journal as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error("meta/_journal.json has no entries list.");
  return entries.map((entry: { tag?: unknown; when?: unknown }) => {
    if (typeof entry.tag !== "string" || typeof entry.when !== "number") {
      throw new Error("an entry in meta/_journal.json has no tag or when.");
    }
    if (!existsSync(join(migrationsFolder, `${entry.tag}.sql`))) {
      throw new Error(`meta/_journal.json lists ${entry.tag}, but ${entry.tag}.sql does not exist.`);
    }
    return { tag: entry.tag, when: entry.when };
  });
}

/** The `created_at` of every row in the history table, or none if it does not exist yet. */
async function appliedTimestamps(client: Client): Promise<number[]> {
  const table = `${HISTORY_SCHEMA}.${HISTORY_TABLE}`;
  const exists = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [table]);
  if (!exists.rows[0]?.exists) return [];
  const rows = await client.query<{ created_at: string | null }>(
    `select created_at from "${HISTORY_SCHEMA}"."${HISTORY_TABLE}"`,
  );
  return rows.rows.flatMap((row) => (row.created_at === null ? [] : [Number(row.created_at)]));
}

function describeSkipped(skipped: readonly JournalEntry[], journal: readonly JournalEntry[], newest: number): string {
  const names = skipped.map((entry) => entry.tag).join(", ");
  const newestTag = journal.find((entry) => entry.when === newest)?.tag;
  const newestName = newestTag
    ? newestTag
    : `a migration from ${new Date(newest).toISOString()} that is not in lib/db/migrations`;
  const one = skipped.length === 1;
  return (
    `${one ? "Migration" : "Migrations"} ${names} ${one ? "has" : "have"} not been applied, ` +
    `but ${one ? "it is" : "they are"} older than ${newestName}, the newest migration that the database has applied. ` +
    `Drizzle would skip ${one ? "it" : "them"} for good, so nothing was applied. ` +
    "This happens when two branches each add a migration. " +
    `Generate ${one ? "it" : "them"} again so that ${one ? "it comes" : "they come"} after the newest one, ` +
    "or start a local database over with `docker compose down -v`."
  );
}

/**
 * Follows `migrate()` through Drizzle's query log, to tell which migration
 * failed. Inside its transaction, `migrate()` runs each pending migration's
 * statements and then inserts that migration's history row.
 */
class MigrationProgress implements Logger {
  /** True once `migrate()` has started its transaction. */
  begun = false;
  /** History rows inserted so far: one per migration whose statements all ran. */
  recorded = 0;

  logQuery(query: string): void {
    if (!this.begun) {
      this.begun = /^\s*begin\b/i.test(query);
    } else if (isHistoryInsert(query)) {
      this.recorded += 1;
    }
  }
}

function isHistoryInsert(query: string): boolean {
  return query.trimStart().startsWith(`insert into "${HISTORY_SCHEMA}"."${HISTORY_TABLE}"`);
}

function describeMigrateError(
  error: unknown,
  pending: readonly JournalEntry[],
  progress: MigrationProgress,
  where: string,
): string {
  const cause = error instanceof DrizzleQueryError && error.cause ? error.cause : error;
  const reason = serverReason(cause);
  if (!progress.begun) {
    // migrate() reads the files, then creates the history table if needed.
    return error instanceof DrizzleQueryError
      ? `Could not create the migration history table ${HISTORY_SCHEMA}.${HISTORY_TABLE} at ${where}: ${reason}`
      : `Could not apply the migrations: ${reason}`;
  }
  // A failed history insert belongs to the migration whose statements just ran.
  const failedInsert = error instanceof DrizzleQueryError && isHistoryInsert(error.query);
  const failed = pending[failedInsert ? progress.recorded - 1 : progress.recorded];
  const rolledBack = "No migration was applied: the pending migrations run in one transaction, which was rolled back.";
  if (!failed) {
    return `Applying the migrations at ${where} failed: ${reason}. ${rolledBack}`;
  }
  return `Migration ${failed.tag} failed at ${where}: ${reason}. ${rolledBack}`;
}

function failure(message: string, secrets: readonly string[]): MigrateDatabaseResult {
  return { ok: false, message: redact(message, secrets) };
}
