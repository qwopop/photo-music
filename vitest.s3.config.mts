import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.mjs";

const config = mergeConfig(baseConfig, defineConfig({
  test: {
    include: ["**/*.s3.test.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
}));
config.test = { ...config.test, exclude: [...configDefaults.exclude] };
export default config;
