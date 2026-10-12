/**
 * `npm run db:check`: checks that the app can connect to the database in
 * `DATABASE_URL`.
 *
 * On success it prints one line to stdout with the PostgreSQL version, the
 * database and the user, and exits 0. Otherwise it prints a short reason to
 * stderr and exits 1. It never prints the password or the full URL.
 *
 * It runs outside Next.js, so package.json starts it as
 * `node --env-file-if-exists=.env.local --import tsx scripts/db-check.ts`:
 * Node loads `.env.local` if it exists, and a variable set in the shell wins
 * over the file.
 */
import { checkDatabase } from "./check-database";

checkDatabase().then(
  (result) => {
    if (result.ok) {
      console.log(result.message);
    } else {
      console.error(result.message);
    }
    process.exitCode = result.ok ? 0 : 1;
  },
  () => {
    // checkDatabase() handles every error it expects. Print nothing from an
    // unexpected one: it could contain the URL.
    console.error("The database check failed unexpectedly.");
    process.exitCode = 1;
  },
);
