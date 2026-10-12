import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { MIGRATIONS_FOLDER, migrateDatabase } from "../../scripts/migrate-database";
import { connectionSettings } from "./connection";
import { createScratchDatabase } from "./test-database";

// Runs with `npm run test:db`. Each test migrates an empty database of its
// own, created next to this run's test database and dropped afterwards. The
// failure cases use migration folders that the tests write to a temporary
// folder, in the format that `drizzle-kit generate` writes.

const testUrl = inject("testDatabaseUrl");
const password = decodeURIComponent(new URL(testUrl).password);

const scriptPath = fileURLToPath(new URL("../../scripts/db-migrate.ts", import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

let fixtures: string;
let scratch: { url: string; drop: () => Promise<void> } | undefined;

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "migrate-db-test-"));
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await scratch?.drop();
  scratch = undefined;
});

async function emptyDatabase(): Promise<string> {
  scratch = await createScratchDatabase(testUrl);
  return scratch.url;
}

async function query<T>(url: string, text: string): Promise<T[]> {
  const client = new Client(connectionSettings({ url }));
  await client.connect();
  try {
    return (await client.query(text)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Whether `name` (such as `public.users`) exists. */
async function exists(url: string, name: string): Promise<boolean> {
  const [row] = await query<{ found: boolean }>(url, `select to_regclass('${name}') is not null as found`);
  return row.found;
}

async function history(url: string): Promise<number[]> {
  if (!(await exists(url, "drizzle.__drizzle_migrations"))) return [];
  const rows = await query<{ created_at: string }>(
    url,
    "select created_at from drizzle.__drizzle_migrations order by created_at",
  );
  return rows.map((row) => Number(row.created_at));
}

interface Migration {
  tag: string;
  when: number;
  sql: string;
}

let folders = 0;

/** Writes a migrations folder: one SQL file per migration, and `meta/_journal.json`. */
function migrationsFolder(migrations: readonly Migration[]): string {
  folders += 1;
  const folder = join(fixtures, `migrations-${folders}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const migration of migrations) {
    writeFileSync(join(folder, `${migration.tag}.sql`), migration.sql);
  }
  const entries = migrations.map(({ tag, when }, idx) => ({ idx, version: "7", when, tag, breakpoints: true }));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  return folder;
}

/** A migration that creates the table `t_<name>`. */
function createTable(name: string, when: number, eol = "\n"): Migration {
  return {
    tag: name,
    when,
    sql: [`CREATE TABLE "t_${name}" (${eol}\t"id" integer${eol});`, `SELECT 1;`].join(`${eol}--> statement-breakpoint${eol}`),
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `npm run db:migrate`'s command, from an empty folder so that no `.env.local` loads. */
function runDbMigrate(): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--env-file-if-exists=.env.local", "--import", tsxLoader, scriptPath], {
      cwd: fixtures,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const committed = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string; when: number }[];
};

describe("npm run db:migrate", () => {
  it("applies the committed migrations on the first run and nothing on the second", async () => {
    vi.stubEnv("DATABASE_URL", await emptyDatabase());
    // Values that would break the connection if pg read them.
    vi.stubEnv("PGSSLMODE", "require");
    vi.stubEnv("PGHOST", "192.0.2.1");
    vi.stubEnv("PGPASSWORD", "wrong");

    const first = await runDbMigrate();

    expect(first.code).toBe(0);
    const lines = first.stdout.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Applied 0000_create_users");
    expect(lines.slice(0, -1)).toEqual(committed.entries.map((entry) => `Applied ${entry.tag}`));
    expect(lines.at(-1)).toMatch(/^Applied \d+ migrations? to the database at (localhost|127\.0\.0\.1|\[::1\]):\d+\.$/);
    expect(await exists(scratch!.url, "public.users")).toBe(true);
    expect(await history(scratch!.url)).toEqual(committed.entries.map((entry) => entry.when));

    const second = await runDbMigrate();

    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/^The database at \S+ is already up to date: there are no migrations to apply\.\n$/);
    expect(await history(scratch!.url)).toEqual(committed.entries.map((entry) => entry.when));

    for (const run of [first, second]) {
      expect(run.stderr.trim()).toBe(".env.local not found. Continuing without it.");
      if (password !== "") expect(run.stdout + run.stderr).not.toContain(password);
    }
  });
});

describe("migrateDatabase", () => {
  it("returns the applied migrations' names", async () => {
    const url = await emptyDatabase();
    const folder = migrationsFolder([createTable("0000_a", 1_000), createTable("0001_b", 2_000)]);

    const result = await migrateDatabase({ config: { url }, migrationsFolder: folder });

    expect(result).toMatchObject({ ok: true, applied: ["0000_a", "0001_b"] });
    expect(await exists(url, "public.t_0000_a")).toBe(true);
    expect(await exists(url, "public.t_0001_b")).toBe(true);
    expect(await history(url)).toEqual([1_000, 2_000]);
  });

  describe("when a pending migration fails", () => {
    it.each([0, 1, 2])("applies none of them, and names the one that failed (number %i)", async (failing) => {
      const url = await emptyDatabase();
      const migrations = [createTable("0000_a", 1_000), createTable("0001_b", 2_000), createTable("0002_c", 3_000)];
      migrations[failing] = {
        ...migrations[failing],
        sql: `${migrations[failing].sql}\n--> statement-breakpoint\nselect 1/0;`,
      };

      const result = await migrateDatabase({ config: { url }, migrationsFolder: migrationsFolder(migrations) });

      expect(result).toStrictEqual({
        ok: false,
        message: expect.stringMatching(
          new RegExp(`^Migration ${migrations[failing].tag} failed at \\S+: division by zero \\(SQLSTATE 22012\\)\\. No migration was applied`),
        ),
      });
      for (const { tag } of migrations) {
        expect(await exists(url, `public.t_${tag}`), tag).toBe(false);
      }
      expect(await history(url)).toEqual([]);
    });

    it("leaves the migrations that were applied before alone", async () => {
      const url = await emptyDatabase();
      const first = createTable("0000_a", 1_000);
      await migrateDatabase({ config: { url }, migrationsFolder: migrationsFolder([first]) });
      const failing = { tag: "0001_fail", when: 2_000, sql: `CREATE TABLE "t_0001_fail" ("id" integer);\n--> statement-breakpoint\nselect 1/0;` };

      const result = await migrateDatabase({ config: { url }, migrationsFolder: migrationsFolder([first, failing]) });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Migration 0001_fail failed");
      expect(result.message).toContain("division by zero");
      expect(await exists(url, "public.t_0000_a")).toBe(true);
      expect(await exists(url, "public.t_0001_fail")).toBe(false);
      expect(await history(url)).toEqual([1_000]);
    });
  });

  describe("with a migration that is older than the newest applied one", () => {
    it("applies nothing and names it", async () => {
      // Branch X added 0001_x and branch Y added 0002_y, generated earlier.
      // The database has applied 0000 and 0001_x already.
      const url = await emptyDatabase();
      const base = createTable("0000_base", 1_000);
      const x = createTable("0001_x", 3_000);
      const y = createTable("0002_y", 2_000);
      const newer = createTable("0003_newer", 4_000);
      await migrateDatabase({ config: { url }, migrationsFolder: migrationsFolder([base, x]) });

      const result = await migrateDatabase({ config: { url }, migrationsFolder: migrationsFolder([base, x, y, newer]) });

      expect(result).toStrictEqual({
        ok: false,
        message:
          "Migration 0002_y has not been applied, but it is older than 0001_x, the newest migration that the database has applied. " +
          "Drizzle would skip it for good, so nothing was applied. This happens when two branches each add a migration. " +
          "Generate it again so that it comes after the newest one, or start a local database over with `docker compose down -v`.",
      });
      expect(await exists(url, "public.t_0002_y")).toBe(false);
      expect(await exists(url, "public.t_0003_newer")).toBe(false);
      expect(await history(url)).toEqual([1_000, 3_000]);
    });

    it("names every such migration, also when the newest applied one is not in the folder", async () => {
      const url = await emptyDatabase();
      const base = createTable("0000_base", 1_000);
      await migrateDatabase({
        config: { url },
        migrationsFolder: migrationsFolder([base, createTable("0001_elsewhere", Date.UTC(2026, 0, 2))]),
      });

      const result = await migrateDatabase({
        config: { url },
        migrationsFolder: migrationsFolder([base, createTable("0001_a", 2_000), createTable("0002_b", 3_000)]),
      });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(
        /^Migrations 0001_a, 0002_b have not been applied, but they are older than a migration from 2026-01-02T00:00:00\.000Z that is not in lib\/db\/migrations,/,
      );
      expect(await history(url)).toEqual([1_000, Date.UTC(2026, 0, 2)]);
    });
  });

  it("matches migrations by their timestamp, not by the file's hash, so line endings do not matter", async () => {
    const url = await emptyDatabase();
    await migrateDatabase({ config: { url }, migrationsFolder: migrationsFolder([createTable("0000_a", 1_000)]) });

    // The same migration as a Windows checkout has it, plus a new one.
    const result = await migrateDatabase({
      config: { url },
      migrationsFolder: migrationsFolder([createTable("0000_a", 1_000, "\r\n"), createTable("0001_b", 2_000, "\r\n")]),
    });

    expect(result).toMatchObject({ ok: true, applied: ["0001_b"] });
    expect(await history(url)).toEqual([1_000, 2_000]);
  });
});
