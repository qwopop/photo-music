/**
 * `npm run test:db`: runs only the tests that need PostgreSQL
 * (`*.db.test.ts`), against a throwaway database.
 *
 * `lib/db/test-database.ts` creates the database on the server in
 * `DATABASE_URL`, applies the migrations to it, hands its URL to the tests,
 * and drops it at the end. package.json starts Vitest with
 * `node --env-file-if-exists=.env.local`, so `.env.local` loads as it does for
 * `npm run db:check`.
 *
 * Everything else, such as the `server-only` alias, comes from
 * vitest.config.mts.
 */
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.mjs";

const config = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["**/*.db.test.ts"],
      globalSetup: ["./lib/db/test-database.ts"],
      // The database tests share one database, so their files run one at a
      // time.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);

// mergeConfig() would add vitest.config.mts's exclude list, which leaves out
// exactly these tests. Use Vitest's defaults instead.
config.test = { ...config.test, exclude: [...configDefaults.exclude] };

export default config;
