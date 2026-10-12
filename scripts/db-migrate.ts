/**
 * `npm run db:migrate`: applies the pending migrations in `lib/db/migrations`
 * to the database in `DATABASE_URL` (see `migrate-database.ts`).
 *
 * On success it prints the name of each migration it applied, or that the
 * database is already up to date, to stdout and exits 0. Otherwise it prints
 * a short reason to stderr and exits 1. It never prints the password or the
 * full URL.
 *
 * It runs outside Next.js, so package.json starts it as
 * `node --env-file-if-exists=.env.local --import tsx scripts/db-migrate.ts`:
 * Node loads `.env.local` if it exists, and a variable set in the shell wins
 * over the file.
 */
import { migrateDatabase } from "./migrate-database";

migrateDatabase().then(
  (result) => {
    if (result.ok) {
      console.log(result.message);
    } else {
      console.error(result.message);
    }
    process.exitCode = result.ok ? 0 : 1;
  },
  () => {
    // migrateDatabase() handles every error it expects. Print nothing from an
    // unexpected one: it could contain the URL.
    console.error("The migration failed unexpectedly.");
    process.exitCode = 1;
  },
);
