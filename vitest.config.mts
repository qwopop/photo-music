import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // `lib/config` starts with `import "server-only"`. Next.js resolves that
      // itself: to this empty module in server code, and to a module that
      // throws in client code. Tests run as server code, so they get the
      // empty module too.
      {
        find: /^server-only$/,
        replacement: "next/dist/compiled/server-only/empty.js",
      },
    ],
  },
  test: {
    environment: "node",
    // Tests that need PostgreSQL run with `npm run test:db`
    // (vitest.db.config.mts), never in `npm test`.
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
  },
});
