/**
 * The `pg` connection settings for the database in `DATABASE_URL`.
 *
 * `getDb()` (the app), `npm run db:migrate`, `npm run test:db` and
 * `npm run db:check` all connect with these settings, so they cannot drift
 * apart. This file has no `server-only`, so scripts and tests can use it, and
 * it reads no environment variable: callers pass in the config from
 * `lib/config` (app code) or `lib/config/node` (scripts).
 */
import type { PoolConfig } from "pg";
import type { DatabaseConfig } from "../config/schema";

/**
 * How long to wait for the server to accept a connection and log in.
 * Without a limit, `pg` waits for the operating system's TCP timeout: over
 * 20 seconds on Windows, about 2 minutes on Linux.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Settings for a `pg` `Client` or `Pool`. Never log them: the URL holds the
 * password.
 *
 * - The URL is the `connectionString`. `pg` lets the URL's own parameters win
 *   over the settings next to it, so a URL with `sslmode` (or `ssl`) still
 *   gets TLS.
 * - `ssl: false` keeps `pg` from reading `PGSSLMODE`, so TLS is used only when
 *   the URL asks for it. `pg` reads the other libpq variables (`PGHOST`,
 *   `PGPASSWORD` and so on) only for parts that the URL leaves out.
 * - The pool size is `pg`'s default.
 */
export function connectionSettings(config: DatabaseConfig): PoolConfig {
  return {
    connectionString: config.url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: false,
  };
}
