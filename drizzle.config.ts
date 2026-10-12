/**
 * Settings for `drizzle-kit`, used only by `npm run db:generate`
 * (`drizzle-kit generate`), which writes SQL migrations from
 * `lib/db/schema.ts`. It needs no database.
 *
 * There are no database credentials here on purpose: `npm run db:migrate` is
 * the only way to apply migrations. Do not use `drizzle-kit push`, `migrate`
 * or `studio`.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
});
