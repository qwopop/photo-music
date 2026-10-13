import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { closeDb, getDb } from "../db";
import { sessions, users } from "../db/schema";
import { authRepository } from "./repository";
import { messages } from "./rules";
import { currentUser, login, logout, signup } from "./service";
import { createToken, sessionId } from "./tokens";

const testUrl = inject("testDatabaseUrl");
const input = { email: "Ann@Example.COM", password: "cafécafé", confirmPassword: "cafécafé" };

beforeAll(() => vi.stubEnv("DATABASE_URL", testUrl));
beforeEach(async () => { await getDb().delete(users); });
afterAll(async () => { await closeDb(); vi.unstubAllEnvs(); });

async function signedUp(email = input.email) {
  const result = await signup({ ...input, email });
  if (!result.ok) throw new Error("Expected successful sign-up");
  return result;
}

describe("accounts and database sessions", () => {
  it("creates a user and finds it by email in another letter case", async () => {
    const result = await signedUp();
    const found = await authRepository.findUser("aNN@eXAMPLE.com");
    expect(found).toMatchObject(result.user);
    expect(found?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await currentUser(result.token)).toEqual(result.user);
    const [session] = await getDb().select().from(sessions);
    expect(session.id).toBe(sessionId(result.token));
    expect(session.id).not.toContain(result.token);
    expect(session.expiresAt).toEqual(result.expiresAt);
    expect(session.createdAt).toBeInstanceOf(Date);
  });
  it("rejects a case-insensitive duplicate and creates no additional session", async () => {
    await signedUp();
    expect(await signup({ ...input, email: "ANN@EXAMPLE.com" })).toEqual({ ok: false, state: { email: "ANN@EXAMPLE.com", message: messages.duplicate, duplicate: true } });
    expect(await getDb().select().from(users)).toHaveLength(1);
    expect(await getDb().select().from(sessions)).toHaveLength(1);
  });
  it("handles two concurrent sign-ups with exactly one account and one session", async () => {
    const results = await Promise.all([signup(input), signup({ ...input, email: input.email.toUpperCase() })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ ok: false, state: { message: messages.duplicate } }]);
    expect(await getDb().select().from(users)).toHaveLength(1);
    expect(await getDb().select().from(sessions)).toHaveLength(1);
  });
  it("expires a presented session and deletes its row without deleting other sessions", async () => {
    const first = await signedUp();
    const second = await login({ email: input.email, password: input.password });
    if (!second.ok) throw new Error("Expected login");
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(sessions.id, sessionId(first.token)));
    expect(await currentUser(first.token)).toBeNull();
    expect(await currentUser(second.token)).toEqual(first.user);
    expect(await getDb().select().from(sessions)).toHaveLength(1);
    await getDb().delete(sessions).where(eq(sessions.id, sessionId(second.token)));
    expect(await currentUser(second.token)).toBeNull();
  });
  it("login deletes only this user's expired sessions", async () => {
    const ann = await signedUp();
    const bob = await signedUp("bob@example.com");
    const annLiveToken = createToken();
    await getDb().insert(sessions).values({ id: sessionId(annLiveToken), userId: ann.user.id, expiresAt: new Date(Date.now() + 60_000) });
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1) }).where(and(eq(sessions.userId, ann.user.id), eq(sessions.id, sessionId(ann.token))));
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(sessions.userId, bob.user.id));
    const result = await login({ email: input.email.toLowerCase(), password: input.password });
    expect(result.ok).toBe(true);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, ann.user.id))).toHaveLength(2);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, bob.user.id))).toHaveLength(1);
    expect(await currentUser(annLiveToken)).toEqual(ann.user);
  });
  it("supports complete signup/login/logout with NFKC, rotation and separate browsers", async () => {
    const first = await signedUp();
    const second = await login({ email: "  ANN@example.com  ", password: "cafe\u0301cafe\u0301" }, first.token);
    if (!second.ok) throw new Error("Expected login");
    expect(second.token).not.toBe(first.token);
    expect(await currentUser(first.token)).toBeNull();
    const other = await login({ email: input.email, password: input.password });
    if (!other.ok) throw new Error("Expected other login");
    const clearCookie = vi.fn();
    await logout(second.token, clearCookie);
    expect(clearCookie).toHaveBeenCalledOnce();
    expect(await currentUser(second.token)).toBeNull();
    expect(await currentUser(other.token)).toEqual(first.user);
  });
  it("revokes the current session even when an already-signed-in login/signup fails", async () => {
    const first = await signedUp();
    expect((await login({ email: input.email, password: "wrong" }, first.token)).ok).toBe(false);
    expect(await currentUser(first.token)).toBeNull();
    const second = await login({ email: input.email, password: input.password });
    if (!second.ok) throw new Error("Expected login");
    expect((await signup(input, second.token)).ok).toBe(false);
    expect(await currentUser(second.token)).toBeNull();
    expect(await getDb().select().from(sessions)).toHaveLength(0);
  });
  it("has exactly the required session columns, primary key, index and cascade", async () => {
    const db = getDb();
    const columns = await db.$client.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='sessions' order by ordinal_position");
    expect(columns.rows).toEqual([
      { column_name: "id", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "expires_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
    expect((await db.$client.query("select indexname, indexdef from pg_indexes where schemaname='public' and tablename='sessions' order by indexname")).rows).toEqual([
      { indexname: "sessions_pkey", indexdef: "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)" },
      { indexname: "sessions_user_id_idx", indexdef: "CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id)" },
    ]);
    const result = await signedUp();
    await db.delete(users).where(eq(users.id, result.user.id));
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await currentUser(result.token)).toBeNull();
  });
});
