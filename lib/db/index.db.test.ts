import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { closeDb, getDb } from "./index";
import { users } from "./schema";

// Runs with `npm run test:db`. getDb() reads DATABASE_URL, which each test
// points at this run's throwaway database. The libpq variables are set to
// values that would break the connection if pg read them.

const testUrl = inject("testDatabaseUrl");
const EMAIL = "Round.Trip@Example.COM";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", testUrl);
  vi.stubEnv("PGSSLMODE", "require");
  vi.stubEnv("PGHOST", "192.0.2.1");
  vi.stubEnv("PGPASSWORD", "wrong");
});

afterEach(async () => {
  await getDb().delete(users).where(eq(users.email, EMAIL));
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await closeDb();
});

describe("getDb()", () => {
  it("inserts a user and reads it back by email through Drizzle", async () => {
    const db = getDb();

    const [inserted] = await db.insert(users).values({ email: EMAIL, passwordHash: "not-a-real-hash" }).returning();
    const found = await db.select().from(users).where(eq(users.email, EMAIL));

    expect(found).toEqual([inserted]);
    expect(inserted).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      email: EMAIL,
      passwordHash: "not-a-real-hash",
      createdAt: expect.any(Date),
    });
    expect(Math.abs(inserted.createdAt.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("returns the same client every time", async () => {
    const db = getDb();
    await db.select().from(users).limit(1);
    expect(getDb()).toBe(db);
  });
});
