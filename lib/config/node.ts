/**
 * Settings for code that runs outside Next.js, such as scripts and tool
 * config files. App code imports `lib/config` instead.
 *
 * `lib/config` starts with `import "server-only"`, which works only inside
 * Next.js, so this entry point does not import it. It reads `process.env` and
 * parses it with the same functions as `lib/config`. Nothing loads
 * `.env.local` for you outside Next.js: start the code with
 * `node --env-file-if-exists=.env.local`, as `npm run db:check` does.
 *
 * It has only the getters that such code needs so far. Add a group's getter
 * here when a tool needs it, and never log what the getters return.
 */
import { parseDatabaseConfig, type DatabaseConfig } from "./schema";

/** `DATABASE_URL`. Throws a `ConfigError` when it is missing or invalid. */
export function getDatabaseConfig(): DatabaseConfig {
  return parseDatabaseConfig(process.env);
}
