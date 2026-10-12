/**
 * Error messages and redaction shared by the database commands:
 * `npm run db:check` (`check-database.ts`), `npm run db:migrate`
 * (`migrate-database.ts`) and `npm run test:db` (`lib/db/test-database.ts`).
 *
 * Every message is one short line that names the host and port, never the
 * password or the full `DATABASE_URL`. `redact()` removes them anyway, as
 * defence in depth.
 */
import { DatabaseError } from "pg";

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

/** Turns an error from `client.connect()` into a short message. */
export function describeConnectError(error: unknown, where: string, timeoutMs: number): string {
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

/** A login that the server refused, with its reason and what to do next. */
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

/**
 * The server's reason for an error after login, such as
 * `division by zero (SQLSTATE 22012)`, or the message of any other error.
 */
export function serverReason(error: unknown): string {
  if (error instanceof DatabaseError) {
    return error.code ? `${error.message} (SQLSTATE ${error.code})` : error.message;
  }
  return messageOf(error);
}

/** The error's code, also for the AggregateError of a `localhost` connection. */
export function errorCode(error: unknown): string | undefined {
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

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return errorCode(error) ?? "unknown error";
}

/** `host:port`, or `[host]:port` for an IPv6 address. */
export function formatAddress(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * The strings to hide from every message: the URL, and the password that
 * `pg` read from it (as is and percent-encoded).
 */
export function secretsOf(url: string, password: unknown): string[] {
  const secrets = [url];
  if (typeof password === "string" && password !== "") {
    secrets.push(password, encodeURIComponent(password));
  }
  return secrets;
}

/** Replaces every secret (the URL and the password) in `text`. */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret !== "") result = result.split(secret).join("[hidden]");
  }
  return result;
}
