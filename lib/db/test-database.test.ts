import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freePort } from "../../scripts/fake-postgres";
import { configVariableNames } from "../config/schema";
import { assertLocalServer, databaseName, databaseUrl } from "./test-database";

// The checks that `npm run test:db` makes before it touches a database. No
// test here needs a database server. The command runs in a child process
// from an empty temporary folder, so `.env.local` there is none, never the
// developer's own. Every URL uses the password "leakcheck-pw", which must
// never appear in the output.

const PASSWORD = "leakcheck-pw";
const COMMAND = "node --env-file-if-exists=.env.local node_modules/vitest/vitest.mjs run --config vitest.db.config.mts";
const root = fileURLToPath(new URL("../..", import.meta.url));

let cwd: string;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** `npm run test:db`'s command, with absolute paths so that it can run from `cwd`. */
function runTestDb(): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--env-file-if-exists=.env.local",
        join(root, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        join(root, "vitest.db.config.mts"),
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

function expectCleanFailure(run: Run): void {
  expect(run.code).not.toBe(0);
  expect(run.code).not.toBeNull();
  expect(run.stderr + run.stdout).not.toContain(PASSWORD);
  expect(run.stderr).not.toMatch(/^\s+at /m);
  expect(run.stdout).not.toMatch(/Test Files|No test files found/);
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "test-db-test-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of configVariableNames) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertLocalServer", () => {
  it.each([
    `postgresql://photo_music:${PASSWORD}@localhost:54320/photo_music`,
    `postgresql://photo_music:${PASSWORD}@127.0.0.1:54320/photo_music`,
    `postgresql://photo_music:${PASSWORD}@[::1]:54320/photo_music`,
    `postgres://photo_music:${PASSWORD}@LOCALHOST/photo_music`,
  ])("accepts %s", (url) => {
    expect(() => assertLocalServer(url)).not.toThrow();
  });

  it.each([
    [`postgresql://photo_music:${PASSWORD}@db.example.com:5432/photo_music`, '"db.example.com"'],
    [`postgresql://photo_music:${PASSWORD}@192.0.2.1:54320/photo_music`, '"192.0.2.1"'],
    [`postgresql://photo_music:${PASSWORD}@localhost.example.com/photo_music`, '"localhost.example.com"'],
    [`postgresql://photo_music:${PASSWORD}@127.0.0.1:54320/photo_music?host=db.example.com`, '"db.example.com"'],
    ["postgresql:///photo_music", "empty"],
  ])("refuses %s and says why, without the password", (url, host) => {
    vi.stubEnv("PGHOST", "localhost");
    expect(() => assertLocalServer(url)).toThrow(
      `npm run test:db runs only against a PostgreSQL server on this computer, because it creates and drops databases there. The host in DATABASE_URL is ${host}.`,
    );
    expect(() => assertLocalServer(url)).not.toThrow(new RegExp(PASSWORD));
  });
});

describe("databaseUrl", () => {
  it("swaps only the database name", () => {
    const url = `postgresql://photo_music:pa%24%24word@localhost:54320/photo_music?sslmode=disable`;
    const swapped = databaseUrl(url, "photo_music_test_abc");

    expect(swapped).toBe("postgresql://photo_music:pa%24%24word@localhost:54320/photo_music_test_abc?sslmode=disable");
    expect(databaseName(swapped)).toBe("photo_music_test_abc");
  });
});

describe("npm run test:db, when it cannot test", { timeout: 60_000 }, () => {
  it("is the command these tests run", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(packageJson.scripts["test:db"]).toBe(COMMAND);
  });

  it("fails with the ConfigError when DATABASE_URL is unset", async () => {
    const run = await runTestDb();

    expectCleanFailure(run);
    expect(run.stderr).toMatch(/^Database configuration is missing or invalid:\n {2}- DATABASE_URL is missing\n/m);
  });

  it("fails with db:check's message when nothing listens", async () => {
    const port = await freePort();
    vi.stubEnv("DATABASE_URL", `postgresql://photo_music:${PASSWORD}@localhost:${port}/photo_music`);

    const run = await runTestDb();

    expectCleanFailure(run);
    expect(run.stderr).toContain(
      `Could not connect to PostgreSQL at localhost:${port}: the connection was refused, so no server is listening there. ` +
        "Start the local database with `docker compose up -d --wait`, or check the host and port in DATABASE_URL.",
    );
  });

  it("refuses a server on another computer before connecting", async () => {
    // 192.0.2.1 never answers: a connection attempt would take 10 seconds.
    vi.stubEnv("DATABASE_URL", `postgresql://photo_music:${PASSWORD}@192.0.2.1:54320/photo_music`);

    const run = await runTestDb();

    expectCleanFailure(run);
    expect(run.stderr).toContain('npm run test:db runs only against a PostgreSQL server on this computer');
    expect(run.ms).toBeLessThan(9_000);
  });
});
