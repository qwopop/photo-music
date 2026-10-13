import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { closeDb, getDb } from "../db";
import { authAttempts, sessions, users } from "../db/schema";
import { LOGIN_EMAIL_LIMIT } from "../auth/limits";
import { login, signup } from "../auth/service";
import { tooManyAttempts } from "../auth/rules";
import { checkRateLimit, hashKey, recordAttempt, RETENTION_MS } from "./index";
import { rateLimitRepository as repository } from "./repository";

const testUrl = inject("testDatabaseUrl");
let time: number;
const now = () => new Date(time);
const rule = { scope: "test", limit: 2, windowMs: 60_000 };

beforeAll(() => vi.stubEnv("DATABASE_URL", testUrl));
beforeEach(async () => {
  time = Date.UTC(2026, 0, 1);
  await getDb().delete(authAttempts);
  await getDb().delete(users);
});
afterAll(async () => { await closeDb(); vi.unstubAllEnvs(); });

describe("rate limit counters on PostgreSQL", () => {
  it("counts in a sliding window with an injected clock", async () => {
    await recordAttempt({ rule, key: "k", repository, now });
    time += 30_000;
    await recordAttempt({ rule, key: "k", repository, now });
    expect(await checkRateLimit({ rule, key: "k", repository, now })).toEqual({ blocked: true, retryAfterMs: 30_000 });
    expect((await checkRateLimit({ rule, key: "other", repository, now })).blocked).toBe(false);
    time += 30_000;
    expect((await checkRateLimit({ rule, key: "k", repository, now })).blocked).toBe(false);
  });
  it("stores only the key hash", async () => {
    await recordAttempt({ rule, key: "ann@example.com", repository, now });
    const rows = await getDb().select().from(authAttempts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "test", keyHash: hashKey("ann@example.com") });
    expect(JSON.stringify(rows)).not.toContain("ann@example.com");
  });
  it("deletes rows older than the retention time on later writes, so the table does not grow", async () => {
    for (let i = 0; i < 5; i++) { await recordAttempt({ rule, key: `k${i}`, repository, now }); time += RETENTION_MS / 2; }
    const rows = await getDb().select().from(authAttempts);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.every((row) => row.createdAt.getTime() > time - RETENTION_MS - RETENTION_MS / 2)).toBe(true);
  });
  it("blocks log in on the real table without writing users or sessions", async () => {
    const context = { ip: "203.0.113.7", now };
    const wrong = { email: "ghost@example.com", password: "wrong-password" };
    for (let i = 0; i < LOGIN_EMAIL_LIMIT.limit; i++) await login(wrong, undefined, undefined, context);
    const blocked = await login(wrong, undefined, undefined, context);
    expect(blocked).toEqual({ ok: false, state: { email: wrong.email, message: tooManyAttempts(10 * 60_000) } });
    expect(await getDb().select().from(users)).toHaveLength(0);
    expect(await getDb().select().from(sessions)).toHaveLength(0);
    time += 10 * 60_000;
    expect(await login(wrong, undefined, undefined, context)).toMatchObject({ state: { message: "Email or password is incorrect." } });
  });
  it("clears the email count after a successful log in", async () => {
    const input = { email: "ann@example.com", password: "cafécafé", confirmPassword: "cafécafé" };
    expect((await signup(input, undefined, undefined, { ip: null, now })).ok).toBe(true);
    const context = { ip: null, now };
    for (let i = 0; i < 4; i++) await login({ email: input.email, password: "nope-nope" }, undefined, undefined, context);
    expect((await login(input, undefined, undefined, context)).ok).toBe(true);
    expect(await getDb().select().from(authAttempts)).toHaveLength(0);
  });
});
