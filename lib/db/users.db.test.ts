import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client, DatabaseError } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../../scripts/migrate-database";
import { connectionSettings } from "./connection";
import { databaseName } from "./test-database";

// Runs with `npm run test:db`, against this run's throwaway database, which
// the global setup (test-database.ts) migrated with the committed migrations.

const testUrl = inject("testDatabaseUrl");
let client: Client;

beforeAll(async () => {
  client = new Client(connectionSettings({ url: testUrl }));
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("delete from users");
});

async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query(text, values)).rows as T[];
}

/** The error of a query that must fail. */
async function failure(text: string, values: unknown[] = []): Promise<DatabaseError> {
  try {
    await client.query(text, values);
  } catch (error) {
    if (error instanceof DatabaseError) return error;
    throw error;
  }
  throw new Error(`Expected the query to fail: ${text}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("the users table", () => {
  it("has exactly id, email, password_hash and created_at", async () => {
    const columns = await rows(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'users'
       order by ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" },
      { column_name: "email", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "password_hash", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
  });

  it("has id as its primary key", async () => {
    const key = await rows<{ attname: string }>(
      `select a.attname
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indrelid = 'public.users'::regclass and i.indisprimary`,
    );
    expect(key).toEqual([{ attname: "id" }]);
  });

  it("gives a row inserted with only email and password_hash a UUID id and the current time", async () => {
    const before = Date.now();
    const [row] = await rows<{ id: string; created_at: Date }>(
      "insert into users (email, password_hash) values ($1, $2) returning id, created_at",
      ["ann@example.com", "hash"],
    );

    expect(row.id).toMatch(UUID);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(Math.abs(row.created_at.getTime() - before)).toBeLessThan(5_000);
  });

  it("gives every row its own id", async () => {
    const inserted = await rows<{ id: string }>(
      "insert into users (email, password_hash) values ('a@example.com', 'h'), ('b@example.com', 'h') returning id",
    );
    expect(new Set(inserted.map((row) => row.id)).size).toBe(2);
  });

  describe("emails", () => {
    it("are unique regardless of letter case, on the index users_email_lower_key", async () => {
      await client.query("insert into users (email, password_hash) values ('ann@example.com', 'hash')");

      const error = await failure("insert into users (email, password_hash) values ('Ann@Example.COM', 'hash')");

      expect(error.code).toBe("23505");
      expect(error.constraint).toBe("users_email_lower_key");
      expect(await rows("select email from users")).toEqual([{ email: "ann@example.com" }]);
    });

    it("keep the case they were inserted with", async () => {
      await client.query("insert into users (email, password_hash) values ('Bob@Example.COM', 'hash')");
      expect(await rows("select email from users")).toEqual([{ email: "Bob@Example.COM" }]);
    });

    it("are indexed by lower(email), in a unique index", async () => {
      const [index] = await rows<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'users_email_lower_key'",
      );
      expect(index.indexdef).toBe("CREATE UNIQUE INDEX users_email_lower_key ON public.users USING btree (lower(email))");
    });
  });

  it.each([
    ["a null email", "insert into users (email, password_hash) values (null, 'hash')"],
    ["no email", "insert into users (password_hash) values ('hash')"],
    ["a null password_hash", "insert into users (email, password_hash) values ('ann@example.com', null)"],
    ["no password_hash", "insert into users (email) values ('ann@example.com')"],
  ])("refuses %s with SQLSTATE 23502", async (_, text) => {
    const error = await failure(text);
    expect(error.code).toBe("23502");
  });
});

describe("the migrations", () => {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  it("are recorded in drizzle.__drizzle_migrations by their journal timestamps", async () => {
    const history = await rows<{ created_at: string }>(
      "select created_at from drizzle.__drizzle_migrations order by created_at",
    );
    expect(history.map((row) => Number(row.created_at))).toEqual(migrations.map((migration) => migration.folderMillis));
  });

  it("the current migration set creates users, sessions and shared YouTube cache", async () => {
    const tables = await rows<{ name: string }>(
      `select table_schema || '.' || table_name as name
       from information_schema.tables
       where table_schema not in ('pg_catalog', 'information_schema')
       order by 1`,
    );
    expect(tables.map((table) => table.name)).toEqual(["drizzle.__drizzle_migrations", "public.sessions", "public.users", "public.youtube_link_cache"]);
  });

  it("0000_create_users alone creates only users, with no session or other table", async () => {
    await client.query("begin");
    try {
      await client.query("create schema historical_users_check");
      await client.query("set local search_path to historical_users_check");
      for (const statement of migrations[0].sql) if (statement.trim()) await client.query(statement);
      expect(await rows("select table_name from information_schema.tables where table_schema = 'historical_users_check' order by table_name"))
        .toEqual([{ table_name: "users" }]);
    } finally {
      await client.query("rollback");
    }
  });

  it("create no extension", async () => {
    expect(await rows("select extname from pg_extension order by extname")).toEqual([{ extname: "plpgsql" }]);
    for (const migration of migrations) {
      expect(migration.sql.join("\n")).not.toMatch(/create\s+extension/i);
    }
  });

  it("0000_create_users needs no superuser rights", async () => {
    // Runs the initial users migration as a role that is not a superuser, in a
    // schema of its own, and rolls it all back. When the test user is a
    // superuser (as in CI), it creates such a role inside the transaction;
    // otherwise it is such a role already.
    const role = `${databaseName(testUrl)}_migrator`;
    await client.query("begin");
    try {
      const [{ rolsuper }] = await rows<{ rolsuper: boolean }>(
        "select rolsuper from pg_roles where rolname = current_user",
      );
      if (rolsuper) {
        await client.query(`create role "${role}" nologin nosuperuser nocreatedb nocreaterole`);
        await client.query(`create schema migration_check authorization "${role}"`);
        await client.query(`set local role "${role}"`);
      } else {
        await client.query("create schema migration_check");
      }
      await client.query("set local search_path to migration_check");
      const [current] = await rows<{ rolsuper: boolean }>(
        "select rolsuper from pg_roles where rolname = current_user",
      );
      expect(current.rolsuper).toBe(false);

      for (const migration of migrations.slice(0, 1)) {
        for (const statement of migration.sql) {
          if (statement.trim() !== "") await client.query(statement);
        }
      }

      const [created] = await rows<{ users: string | null }>("select to_regclass('migration_check.users')::text as users");
      expect(created.users).toBe("users");
    } finally {
      await client.query("rollback");
    }
  });
});
