/**
 * The connection check behind `npm run db:check` (see `db-check.ts`).
 *
 * It reads `DATABASE_URL` through `lib/config/node`, connects with `pg`, runs
 * one query and closes the connection. It never throws: every outcome is a
 * one-line result (a `ConfigError` keeps its own lines), and no result
 * contains the password or the full `DATABASE_URL`.
 */
import { Client, DatabaseError } from "pg";
import { getDatabaseConfig } from "../lib/config/node";
import { ConfigError } from "../lib/config/schema";

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

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The errors a login usually ends with, by SQLSTATE: what the code means,
 * for when the server's own message cannot be shown, and what to do next.
 */
const SERVER_ERRORS: Readonly<Record<string, { meaning: string; hint: string }>> = {
  "28P01": {
    meaning: "password authentication failed",
    hint: "Check the user and password in DATABASE_URL.",
  },
  "28000": {
    meaning: "the server does not let this user connect",
    hint: "Check the user in DATABASE_URL, and the server's pg_hba.conf.",
  },
  "3D000": {
    meaning: "the database does not exist",
    hint: "Check the database name in DATABASE_URL.",
  },
  "57P03": {
    meaning: "the server is not accepting connections yet",
    hint: "It may be starting up or shutting down. Try again in a moment.",
  },
};

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

  const secrets = [url];
  let client: Client;
  try {
    client = new Client({
      connectionString: url,
      connectionTimeoutMillis: connectTimeoutMs,
      query_timeout: connectTimeoutMs,
    });
  } catch (error) {
    return failure(`The PostgreSQL driver could not use DATABASE_URL: ${messageOf(error)}`, secrets);
  }
  if (typeof client.password === "string" && client.password !== "") {
    secrets.push(client.password, encodeURIComponent(client.password));
  }
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

/** Turns an error from `client.connect()` into a short message. */
function describeConnectError(error: unknown, where: string, timeoutMs: number): string {
  if (error instanceof DatabaseError) {
    return describeServerError(error, where);
  }

  const code = errorCode(error);
  const seconds = Math.round(timeoutMs / 100) / 10;
  switch (code) {
    case "ECONNREFUSED":
      return `Could not connect to PostgreSQL at ${where}: the connection was refused, so no server is listening there. Start the local database with \`docker compose up -d --wait\`, or check the host and port in DATABASE_URL.`;
    case "ETIMEDOUT":
      return `Could not connect to PostgreSQL at ${where}: the connection timed out. Check the host and port in DATABASE_URL, and that the server is reachable from this computer.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not connect to PostgreSQL at ${where}: the host name could not be resolved. Check the host in DATABASE_URL.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `Could not connect to PostgreSQL at ${where}: the host is unreachable from this computer. Check the host in DATABASE_URL.`;
  }
  // pg's own connect timeout (connectionTimeoutMillis) has no error code.
  if (/timeout/i.test(messageOf(error))) {
    return `Could not connect to PostgreSQL at ${where}: the connection timed out after ${seconds} seconds. Check the host and port in DATABASE_URL, and that the server is running and reachable from this computer.`;
  }
  return `Could not connect to PostgreSQL at ${where}: ${messageOf(error)}`;
}

function describeServerError(error: DatabaseError, where: string): string {
  const known = error.code ? SERVER_ERRORS[error.code] : undefined;
  const code = error.code ? `SQLSTATE ${error.code}` : "";
  let reason: string;
  // During login the server has not switched to UTF-8 yet, so a server with
  // translated messages (lc_messages) can send text that does not decode.
  if (error.message.includes("�")) {
    const unreadable = "the server's own message is not UTF-8 text, so it is not shown";
    reason = known
      ? `${known.meaning} (${code}; ${unreadable})`
      : `${unreadable}${code ? ` (${code})` : ""}`;
  } else {
    reason = `${error.message}${code ? ` (${code})` : ""}`;
  }
  return `PostgreSQL at ${where} refused the connection: ${reason}.${known ? ` ${known.hint}` : ""}`;
}

/** The error's code, also for the AggregateError of a `localhost` connection. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  if (typeof code === "string" && code !== "") return code;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const innerCode = errorCode(inner);
      if (innerCode) return innerCode;
    }
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return errorCode(error) ?? "unknown error";
}

function formatAddress(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Replaces every secret (the URL and the password) in `text`. */
function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret !== "") result = result.split(secret).join("[hidden]");
  }
  return result;
}

function failure(message: string, secrets: readonly string[]): CheckDatabaseResult {
  return { ok: false, message: redact(message, secrets) };
}
