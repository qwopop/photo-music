import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Environment variables are read and validated in one place: lib/config.
  {
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read environment variables only through lib/config, by calling its getters (such as getSpotifyConfig()) while handling a request. To add a variable, add it to the schema in lib/config/schema.ts and to .env.example.",
        },
      ],
    },
  },
  {
    // The config module's entry points are the only files that read
    // process.env: index.ts for app code, and node.ts for code that runs
    // outside Next.js. lib/config/schema.ts takes the environment as an
    // argument instead.
    files: ["lib/config/index.ts", "lib/config/node.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
