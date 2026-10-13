import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import * as passwords from "./passwords";
import type { AuthRepository } from "./repository";
import { messages, tooManyAttempts } from "./rules";
import { login, signup } from "./service";
import { hashKey, type RateLimitRepository } from "../rate-limit";
import { memoryRateLimitRepository } from "../rate-limit/memory";

const user = { id: "00000000-0000-4000-8000-000000000001", email: "ann@example.com" };
const wrong = { email: "ann@example.com", password: "wrong-password" };
let repository: AuthRepository;
let limits: ReturnType<typeof memoryRateLimitRepository>;
let time: number;
const now = () => new Date(time);
const ctx = (ip: string | null = "203.0.113.7") => ({ ip, limits, now });
let correct: boolean;

beforeEach(async () => {
  time = Date.UTC(2026, 0, 1);
  limits = memoryRateLimitRepository();
  correct = false;
  repository = { signup: vi.fn().mockResolvedValue(user), findUser: vi.fn(), login: vi.fn(), findSession: vi.fn(), deleteSession: vi.fn() };
  vi.mocked(repository.findUser).mockImplementation(async (email) => (email.toLowerCase() === user.email ? { ...user, passwordHash: "stored" } : null));
  vi.spyOn(passwords, "verifyPassword").mockImplementation(async () => correct);
  vi.spyOn(passwords, "hashPassword").mockResolvedValue("$argon2id$fake");
});
afterEach(() => vi.restoreAllMocks());

const attempt = (input = wrong, ip: string | null = "203.0.113.7") => login(input, undefined, repository, ctx(ip));
const state = (result: Awaited<ReturnType<typeof login>>) => (result.ok ? null : result.state.message);

describe("login limits", () => {
  it("answers 5 failures normally and blocks the 6th, for existing and unknown emails alike", async () => {
    const results: Record<string, (string | null | undefined)[]> = {};
    for (const email of ["ann@example.com", "nobody@example.com"]) {
      limits.rows.length = 0;
      results[email] = [];
      for (let i = 0; i < 6; i++) { results[email].push(state(await attempt({ ...wrong, email }))); time += 30_000; }
      time = Date.UTC(2026, 0, 1);
    }
    expect(results["ann@example.com"]).toEqual(results["nobody@example.com"]);
    expect(results["ann@example.com"].slice(0, 5)).toEqual(Array(5).fill(messages.incorrect));
    expect(results["ann@example.com"][5]).toBe("Too many attempts. Try again in 8 minutes.");
  });
  it("refuses a correct password while blocked, without hashing or session rows", async () => {
    for (let i = 0; i < 5; i++) await attempt();
    correct = true;
    vi.mocked(passwords.verifyPassword).mockClear();
    const result = await attempt();
    expect(state(result)).toBe(tooManyAttempts(10 * 60_000));
    expect(passwords.verifyPassword).not.toHaveBeenCalled();
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    expect(repository.findUser).toHaveBeenCalledTimes(5);
    expect(repository.login).not.toHaveBeenCalled();
    expect(limits.rows).toHaveLength(10);
  });
  it("evaluates normally again after the window", async () => {
    for (let i = 0; i < 5; i++) await attempt();
    expect(state(await attempt())).toMatch(/^Too many/);
    time += 10 * 60_000;
    correct = true;
    expect((await attempt()).ok).toBe(true);
  });
  it("treats the email case-insensitively and counts email A separately from B on another IP", async () => {
    for (let i = 0; i < 5; i++) await attempt({ ...wrong, email: i % 2 ? "ANN@example.com" : " ann@example.com " });
    expect(state(await attempt({ ...wrong, email: "Ann@Example.com" }))).toMatch(/^Too many/);
    expect(state(await attempt({ ...wrong, email: "bob@example.com" }, "198.51.100.1"))).toBe(messages.incorrect);
  });
  it("blocks the 21st failure from one IP across different emails", async () => {
    for (let i = 0; i < 20; i++) expect(state(await attempt({ ...wrong, email: `user${i}@example.com` }))).toBe(messages.incorrect);
    expect(state(await attempt({ ...wrong, email: "user99@example.com" }))).toMatch(/^Too many/);
    expect(state(await attempt({ ...wrong, email: "user99@example.com" }, "198.51.100.1"))).toBe(messages.incorrect);
  });
  it("clears the email count on success but keeps the IP count", async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) expect(state(await attempt())).toBe(messages.incorrect);
      correct = true;
      expect((await attempt()).ok).toBe(true);
      correct = false;
    }
    expect(limits.rows.filter((row) => row.scope === "login_ip")).toHaveLength(8);
    expect(limits.rows.filter((row) => row.scope === "login_email")).toHaveLength(0);
  });
  it.each([{ email: "", password: "x" }, { email: "a@b.c", password: "" }, { email: "", password: "" }, { email: "a".repeat(255), password: "x" }, { email: "a@b.c", password: "a".repeat(129) }])("does not count invalid input %#", async (input) => {
    await attempt(input);
    expect(limits.rows).toHaveLength(0);
  });
  it("applies the email limit and still works with no usable IP", async () => {
    for (let i = 0; i < 5; i++) expect(state(await attempt(wrong, null))).toBe(messages.incorrect);
    expect(state(await attempt(wrong, null))).toMatch(/^Too many/);
    expect(limits.rows.every((row) => row.scope === "login_email")).toBe(true);
    correct = true;
    expect((await attempt({ ...wrong, email: "ann2@example.com" }, null)).ok).toBe(false);
  });
  it("stores only hashes, never the raw email or IP", async () => {
    await attempt();
    expect(JSON.stringify(limits.rows)).not.toContain("ann@example.com");
    expect(JSON.stringify(limits.rows)).not.toContain("203.0.113.7");
    expect(limits.rows.map((row) => row.keyHash).sort()).toEqual([hashKey("203.0.113.7"), hashKey("ann@example.com")].sort());
  });
  it("shows the generic failure and hashes nothing when the counter query fails", async () => {
    const secrets = ["ann@example.com", "select count", "SQL parameter"];
    const broken: RateLimitRepository = { ...limits, count: vi.fn().mockRejectedValue(new DrizzleQueryError(secrets[1], secrets, new Error(secrets.join(" ")))) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await login(wrong, undefined, repository, { ip: "203.0.113.7", limits: broken, now });
    expect(state(result)).toBe(messages.failure);
    expect(passwords.verifyPassword).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    for (const secret of secrets) expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});

describe("signup limits", () => {
  const input = { email: "new@example.com", password: "12345678", confirmPassword: "12345678" };
  const go = (ip: string | null = "203.0.113.7") => signup(input, undefined, repository, ctx(ip));

  it("blocks the 11th attempt from one IP within an hour and creates no account", async () => {
    for (let i = 0; i < 10; i++) expect((await go()).ok).toBe(true);
    vi.mocked(passwords.hashPassword).mockClear();
    vi.mocked(repository.signup).mockClear();
    const result = await go();
    expect(result.ok ? null : result.state.message).toBe("Too many attempts. Try again in 60 minutes.");
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    expect(repository.signup).not.toHaveBeenCalled();
    expect((await go("198.51.100.1")).ok).toBe(true);
    time += 60 * 60_000;
    expect((await go()).ok).toBe(true);
  });
  it("counts only attempts that reach hashing, and skips the limit with no IP", async () => {
    await signup({ ...input, password: "" }, undefined, repository, ctx());
    expect(limits.rows).toHaveLength(0);
    for (let i = 0; i < 12; i++) expect((await go(null)).ok).toBe(true);
    expect(limits.rows).toHaveLength(0);
  });
});
