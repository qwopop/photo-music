import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import * as passwords from "./passwords";
import type { AuthRepository } from "./repository";
import { isDuplicateEmail } from "./errors";
import { messages } from "./rules";
import { currentUser, login, logout, signup } from "./service";
import { createToken, sessionId, SESSION_LIFETIME_MS } from "./tokens";

const input = { email: "  Ann@Example.COM  ", password: "12345678", confirmPassword: "12345678" };
const user = { id: "00000000-0000-4000-8000-000000000001", email: "Ann@Example.COM" };
let repository: AuthRepository;
beforeEach(() => {
  repository = { signup: vi.fn().mockResolvedValue(user), findUser: vi.fn().mockResolvedValue(null), login: vi.fn(), findSession: vi.fn().mockResolvedValue(null), deleteSession: vi.fn() };
});
afterEach(() => vi.restoreAllMocks());

describe("sign-up service", () => {
  it("stores only the normalized hash and token hash, preserving email case", async () => {
    const before = Date.now();
    const result = await signup(input, undefined, repository);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected sign-up");
    expect(repository.signup).toHaveBeenCalledWith("Ann@Example.COM", expect.stringMatching(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/), { id: sessionId(result.token), expiresAt: result.expiresAt });
    expect(result.expiresAt.getTime() - before).toBeGreaterThanOrEqual(SESSION_LIFETIME_MS);
    expect(result.expiresAt.getTime() - before).toBeLessThan(SESSION_LIFETIME_MS + 1_000);
    expect(Object.keys(result.user).sort()).toEqual(["email", "id"]);
  });
  it("retains raw email and returns no password or confirmation for validation failures", async () => {
    const result = await signup({ ...input, password: "secret", confirmPassword: "bad" }, undefined, repository);
    expect(result).toEqual({ ok: false, state: { email: input.email, errors: { password: messages.passwordShort, confirmPassword: messages.passwordMismatch } } });
    expect(repository.signup).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each([false, true])("maps only users_email_lower_key duplicate, wrapped=%s", async (wrapped) => {
    const cause = Object.assign(new Error("email and hash and SQL"), { code: "23505", constraint: "users_email_lower_key" });
    const error = wrapped ? new DrizzleQueryError("private SQL", ["private parameter"], cause) : cause;
    vi.mocked(repository.signup).mockRejectedValue(error);
    expect(await signup(input, undefined, repository)).toEqual({ ok: false, state: { email: input.email, message: messages.duplicate, duplicate: true } });
  });
  it.each([{ code: "23505", constraint: "other_key" }, { code: "08006" }, new Error("database secrets")])("maps any other database error safely", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(repository.signup).mockRejectedValue(error);
    expect(await signup(input, undefined, repository)).toEqual({ ok: false, state: { email: input.email, message: messages.failure } });
    expect(log).toHaveBeenCalledOnce();
  });
  it("revokes the browser session before validation or account creation", async () => {
    const token = createToken();
    await signup({ ...input, password: "" }, token, repository);
    expect(repository.deleteSession).toHaveBeenCalledWith(sessionId(token));
    expect(repository.signup).not.toHaveBeenCalled();
  });
  it("logs neither signup nor login inputs, Drizzle SQL, hashes or tokens on an outage", async () => {
    const token = createToken();
    const secrets = ["leakcheck@example.com", "leakcheck-pw-123", "$argon2id$hash", token, sessionId(token), "select password_hash", "SQL parameter"];
    const failure = new DrizzleQueryError(secrets[5], secrets, new Error(secrets.join(" ")));
    vi.mocked(repository.signup).mockRejectedValue(failure);
    vi.mocked(repository.findUser).mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const attempt = { email: secrets[0], password: secrets[1], confirmPassword: secrets[1] };
    expect(await signup(attempt, undefined, repository)).toEqual({ ok: false, state: { email: attempt.email, message: messages.failure } });
    expect(await login(attempt, undefined, repository)).toEqual({ ok: false, state: { email: attempt.email, message: messages.failure } });
    expect(log).toHaveBeenCalledTimes(2);
    for (const secret of secrets) expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});

describe("login service", () => {
  it("still verifies an unknown email against the fixed dummy hash", async () => {
    const verify = vi.spyOn(passwords, "verifyPassword");
    expect(await login(input, undefined, repository)).toEqual({ ok: false, state: { email: input.email, message: messages.incorrect } });
    expect(verify).toHaveBeenCalledWith(await passwords.getDummyHash(), input.password);
  });
  it.each([{ ...input, email: "a".repeat(255) }, { ...input, password: "a".repeat(129) }, { ...input, password: "😀".repeat(129) }])("does not hash, verify or query overlong input", async (value) => {
    const hash = vi.spyOn(passwords, "hashPassword");
    const verify = vi.spyOn(passwords, "verifyPassword");
    expect(await login(value, undefined, repository)).toMatchObject({ ok: false, state: { message: messages.incorrect } });
    expect(repository.findUser).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
  it("reports empty fields together without a query", async () => {
    expect(await login({ email: "", password: "" }, undefined, repository)).toEqual({ ok: false, state: { email: "", errors: { email: messages.emailRequired, password: messages.loginPasswordRequired } } });
    expect(repository.findUser).not.toHaveBeenCalled();
  });
  it("returns the same incorrect message for a wrong password and a corrupt hash", async () => {
    for (const passwordHash of [await passwords.hashPassword("87654321"), "not a hash"]) {
      vi.mocked(repository.findUser).mockResolvedValue({ ...user, passwordHash });
      expect(await login(input, undefined, repository)).toEqual({ ok: false, state: { email: input.email, message: messages.incorrect } });
    }
    expect(repository.login).not.toHaveBeenCalled();
  });
  it("creates a new session each time and returns no stored password hash", async () => {
    vi.mocked(repository.findUser).mockResolvedValue({ ...user, passwordHash: await passwords.hashPassword(input.password) });
    const a = await login(input, undefined, repository);
    const b = await login(input, a.ok ? a.token : undefined, repository);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("Expected login");
    expect(a.token).not.toBe(b.token);
    expect(repository.deleteSession).toHaveBeenCalledWith(sessionId(a.token));
    expect(repository.findUser).toHaveBeenCalledWith("Ann@Example.COM");
    expect(repository.login).toHaveBeenLastCalledWith(user.id, { id: sessionId(b.token), expiresAt: b.expiresAt }, expect.any(Date));
    expect(b.user).toEqual(user);
  });
});

describe("session lookup and logout", () => {
  it.each([undefined, "", "malformed", "a".repeat(44)])("no/malformed cookie performs no query: %j", async (token) => {
    expect(await currentUser(token, repository)).toBeNull();
    expect(repository.findSession).not.toHaveBeenCalled();
  });
  it("returns only identity, without extending a valid session", async () => {
    const token = createToken();
    vi.mocked(repository.findSession).mockResolvedValue({ user, expiresAt: new Date(Date.now() + 60_000) });
    expect(await currentUser(token, repository)).toEqual(user);
    expect(repository.findSession).toHaveBeenCalledWith(sessionId(token));
    expect(repository.login).not.toHaveBeenCalled();
    expect(repository.deleteSession).not.toHaveBeenCalled();
  });
  it("deletes an expired session and returns null", async () => {
    const token = createToken();
    vi.mocked(repository.findSession).mockResolvedValue({ user, expiresAt: new Date(Date.now() - 1) });
    expect(await currentUser(token, repository)).toBeNull();
    expect(repository.deleteSession).toHaveBeenCalledWith(sessionId(token));
  });
  it("returns null for an unknown or deleted token", async () => expect(await currentUser(createToken(), repository)).toBeNull());
  it("propagates outages instead of pretending they are guests", async () => {
    const failure = new Error("database unavailable");
    vi.mocked(repository.findSession).mockRejectedValue(failure);
    await expect(currentUser(createToken(), repository)).rejects.toBe(failure);
  });
  it("clears the cookie even when deletion fails, with no secret in its log", async () => {
    const token = createToken();
    const secrets = ["leakcheck@example.com", "leakcheck-pw-123", "$argon2id$hash", token, sessionId(token), "select password_hash", "private SQL parameter"];
    vi.mocked(repository.deleteSession).mockRejectedValue(new DrizzleQueryError(secrets[5], secrets, new Error(secrets.join(" "))));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const clear = vi.fn();
    await logout(token, clear, repository);
    expect(clear).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    for (const secret of secrets) expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it.each([undefined, "malformed", createToken()])("logout is idempotent for cookie %j", async (token) => {
    const clear = vi.fn();
    await logout(token, clear, repository);
    expect(clear).toHaveBeenCalledOnce();
  });
});

it("does not confuse other constraints or deep/non-object error values with a duplicate", () => {
  for (const error of [null, undefined, "23505", { code: "23505" }, { constraint: "users_email_lower_key" }, { code: "23505", constraint: "different" }]) expect(isDuplicateEmail(error)).toBe(false);
});
