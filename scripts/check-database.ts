/**
 * The connection check behind `npm run db:check` (see `db-check.ts`).
 *
 * It reads `DATABASE_URL` through `lib/config/node`, connects with `pg`, runs
 * one query and closes the connection. It never throws: every outcome is a
 * one-line result (a `ConfigError` keeps its own lines), and no result
 * contains the password or the full `DATABASE_URL`.
 *
 * It connects with the same settings as the app (`lib/db/connection.ts`),
 * and its messages come from `database-errors.ts`, which `db:migrate` and
 * `test:db` share.
 */
import { Client } from "pg";
import { getDatabaseConfig } from "../lib/config/node";
import { ConfigError } from "../lib/config/schema";
import { CONNECT_TIMEOUT_MS, connectionSettings } from "../lib/db/connection";
import { describeConnectError, formatAddress, messageOf, redact, secretsOf } from "./database-errors";

export interface CheckDatabaseOptions {
  /**
   * How long to wait for the server to accept the connection and log in.
   * Without a limit, `pg` waits for the operating system's TCP timeout:
   * over 20 seconds on Windows, about 2 minutes on Linux.
   */
  connectTimeoutMs?: number;
}

export type CheckDatabaseResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export const DEFAULT_CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS;

const CHECK_QUERY =
  "select current_setting('server_version') as server_version, " +
  "current_database() as database_name, current_user as user_name";

interface CheckRow {
  server_version: string;
  database_name: string;
  user_name: string;
}

export async function checkDatabase(
  options: CheckDatabaseOptions = {},
): Promise<CheckDatabaseResult> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let url: string;
  try {
    ({ url } = getDatabaseConfig());
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, message: error.message };
    return { ok: false, message: "Could not read DATABASE_URL." };
  }

  let secrets = [url];
  let client: Client;
  try {
    client = new Client({
      ...connectionSettings({ url }),
      connectionTimeoutMillis: connectTimeoutMs,
      query_timeout: connectTimeoutMs,
    });
  } catch (error) {
    return failure(`The PostgreSQL driver could not use DATABASE_URL: ${messageOf(error)}`, secrets);
  }
  secrets = secretsOf(url, client.password);
  // An error after the connection is up (such as the server closing it)
  // would otherwise crash the process with a stack trace. The pending
  // connect or query rejects with it instead.
  client.on("error", () => {});

  const where = formatAddress(client.host, client.port);
  try {
    try {
      await client.connect();
    } catch (error) {
      return failure(describeConnectError(error, where, connectTimeoutMs), secrets);
    }

    let row: CheckRow;
    try {
      const result = await client.query<CheckRow>(CHECK_QUERY);
      row = result.rows[0];
    } catch (error) {
      return failure(
        `Connected to PostgreSQL at ${where}, but the check query failed: ${messageOf(error)}`,
        secrets,
      );
    }

    return {
      ok: true,
      message: redact(
        `Connected to PostgreSQL ${row.server_version} at ${where}, ` +
          `database "${row.database_name}", user "${row.user_name}".`,
        secrets,
      ),
    };
  } finally {
    // Resolves at once if the connection never opened or is already closed.
    await client.end().catch(() => {});
  }
}

function failure(message: string, secrets: readonly string[]): CheckDatabaseResult {
  return { ok: false, message: redact(message, secrets) };
}
