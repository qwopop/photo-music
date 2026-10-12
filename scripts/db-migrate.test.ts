import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configVariableNames } from "../lib/config/schema";
import { freePort, startFakePostgres, type FakePostgres } from "./fake-postgres";

// Runs `npm run db:migrate`'s command in a child process, as a developer
// would: `node --env-file-if-exists=.env.local --import tsx scripts/db-migrate.ts`.
// The child runs in an empty temporary folder, so `.env.local` there is one
// that a test writes (or none), never the developer's own. It inherits this
// process's environment, which each test sets with vi.stubEnv. No test needs
// a database server; `npm run test:db` runs the command against a real one
// (lib/db/migrate.db.test.ts).

const PASSWORD = "leakcheck-pw";
const COMMAND = "node --env-file-if-exists=.env.local --import tsx scripts/db-migrate.ts";
const scriptPath = fileURLToPath(new URL("./db-migrate.ts", import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

let cwd: string;
let server: FakePostgres | undefined;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runDbMigrate(): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--env-file-if-exists=.env.local", "--import", tsxLoader, scriptPath],
      { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function url(host: string, port: number): string {
  return `postgresql://photo_music:${PASSWORD}@${host}:${port}/photo_music`;
}

/** Node's own line about a missing `.env.local`, which is expected. */
const NO_ENV_FILE = ".env.local not found. Continuing without it.";

/** stderr without Node's line about a missing `.env.local`. */
function ownStderr(run: Run): string {
  return run.stderr
    .split(/\r?\n/)
    .filter((line) => line !== "" && line !== NO_ENV_FILE)
    .join("\n");
}

function expectCleanFailure(run: Run): void {
  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
  expect(ownStderr(run)).not.toBe("");
  // No stack trace, and no secret.
  expect(run.stderr).not.toMatch(/^\s+at /m);
  expect(run.stderr).not.toContain(PASSWORD);
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "db-migrate-test-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of configVariableNames) {
    vi.stubEnv(name, undefined);
  }
  rmSync(join(cwd, ".env.local"), { force: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
});

describe("npm run db:migrate", { timeout: 30_000 }, () => {
  it("is the command these tests run", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["db:migrate"]).toBe(COMMAND);
  });

  it("exits 1 with the ConfigError message when DATABASE_URL is unset and there is no .env.local", async () => {
    const run = await runDbMigrate();

    expectCleanFailure(run);
    expect(run.stderr).toContain(NO_ENV_FILE);
    expect(ownStderr(run)).toMatch(
      /^Database configuration is missing or invalid:\n {2}- DATABASE_URL is missing\n[\s\S]*\.env\.example/,
    );
  });

  it("exits 1 with the ConfigError reason for a mysql:// URL", async () => {
    vi.stubEnv("DATABASE_URL", `mysql://photo_music:${PASSWORD}@localhost:54320/photo_music`);

    const run = await runDbMigrate();

    expectCleanFailure(run);
    expect(ownStderr(run)).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
  });

  it("exits 1 with db:check's message when nothing listens at localhost", async () => {
    const port = await freePort();
    vi.stubEnv("DATABASE_URL", url("localhost", port));

    const run = await runDbMigrate();

    expectCleanFailure(run);
    expect(ownStderr(run)).toBe(
      `Could not connect to PostgreSQL at localhost:${port}: the connection was refused, so no server is listening there. ` +
        "Start the local database with `docker compose up -d --wait`, or check the host and port in DATABASE_URL.",
    );
  });

  it("exits 1 with the server's reason when the login fails", async () => {
    server = await startFakePostgres("wrong-password");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));

    const run = await runDbMigrate();

    expectCleanFailure(run);
    expect(ownStderr(run)).toBe(
      `PostgreSQL at 127.0.0.1:${server.port} refused the connection: ` +
        'password authentication failed for user "photo_music" (SQLSTATE 28P01). ' +
        "Check the user and password in DATABASE_URL.",
    );
  });

  it("ignores PGSSLMODE, PGHOST and PGPASSWORD set in the shell", async () => {
    server = await startFakePostgres("wrong-password");
    vi.stubEnv("DATABASE_URL", url("127.0.0.1", server.port));
    vi.stubEnv("PGSSLMODE", "require");
    vi.stubEnv("PGHOST", "192.0.2.1");
    vi.stubEnv("PGPASSWORD", "wrong");

    const run = await runDbMigrate();

    expectCleanFailure(run);
    expect(ownStderr(run)).toContain(`127.0.0.1:${server.port} refused the connection: password authentication failed`);
  });

  describe("with a .env.local file", () => {
    it("reads DATABASE_URL from .env.local", async () => {
      server = await startFakePostgres("wrong-password");
      writeFileSync(join(cwd, ".env.local"), `DATABASE_URL=${url("127.0.0.1", server.port)}\n`);

      const run = await runDbMigrate();

      expectCleanFailure(run);
      expect(run.stderr).not.toContain(NO_ENV_FILE);
      expect(ownStderr(run)).toContain(`127.0.0.1:${server.port} refused the connection`);
    });

    it("lets a DATABASE_URL set in the shell win over .env.local", async () => {
      server = await startFakePostgres("wrong-password");
      writeFileSync(join(cwd, ".env.local"), `DATABASE_URL=${url("127.0.0.1", server.port)}\n`);
      const port = await freePort();
      vi.stubEnv("DATABASE_URL", url("localhost", port));

      const run = await runDbMigrate();

      expectCleanFailure(run);
      expect(ownStderr(run)).toContain(`localhost:${port}: the connection was refused`);
      expect(server.connections).toBe(0);
    });
  });
});
