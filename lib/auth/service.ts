import { isDuplicateEmail, logAuthFailure } from "./errors";
import { getDummyHash, hashPassword, verifyPassword } from "./passwords";
import { authRepository, type AuthRepository, type AuthUser } from "./repository";
import { messages, validateLogin, tooManyAttempts, validateSignup, type AuthFormState, type Credentials, type SignupInput } from "./rules";
import { LOGIN_EMAIL_LIMIT, LOGIN_IP_LIMIT, SIGNUP_IP_LIMIT } from "./limits";
import { checkRateLimit, clearAttempts, recordAttempt, type RateLimitRepository, type RateLimitRule } from "../rate-limit";
import { rateLimitRepository } from "../rate-limit/repository";
import { createToken, sessionId, SESSION_LIFETIME_MS, validToken } from "./tokens";

export type AuthResult = { ok: true; token: string; expiresAt: Date; user: AuthUser } | { ok: false; state: AuthFormState };

async function revokeCurrent(token: string | undefined, repository: AuthRepository): Promise<void> {
  if (validToken(token)) await repository.deleteSession(sessionId(token));
}

/** Per-request context for rate limits. `ip` is the client key from `clientIpKey`, or null when unknown. */
export interface RateLimitContext {
  ip?: string | null;
  limits?: RateLimitRepository;
  now?: () => Date;
}

/** The longest wait among the rules that block, or null when none does. */
async function blockedFor(rules: { rule: RateLimitRule; key: string }[], context: RateLimitContext): Promise<number | null> {
  const { limits = rateLimitRepository, now } = context;
  let wait: number | null = null;
  for (const { rule, key } of rules) {
    const result = await checkRateLimit({ rule, key, repository: limits, now });
    if (result.blocked) wait = Math.max(wait ?? 0, result.retryAfterMs);
  }
  return wait;
}

export async function signup(input: SignupInput, currentToken?: string, repository: AuthRepository = authRepository, context: RateLimitContext = {}): Promise<AuthResult> {
  const state: AuthFormState = { email: input.email };
  try {
    await revokeCurrent(currentToken, repository);
    const errors = validateSignup(input);
    if (Object.keys(errors).length) return { ok: false, state: { ...state, errors } };
    const { ip, limits = rateLimitRepository, now } = context;
    if (ip) {
      const wait = await blockedFor([{ rule: SIGNUP_IP_LIMIT, key: ip }], context);
      if (wait !== null) return { ok: false, state: { ...state, message: tooManyAttempts(wait) } };
      await recordAttempt({ rule: SIGNUP_IP_LIMIT, key: ip, repository: limits, now });
    }
    const passwordHash = await hashPassword(input.password);
    const token = createToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    const user = await repository.signup(input.email.trim(), passwordHash, { id: sessionId(token), expiresAt });
    return { ok: true, token, expiresAt, user };
  } catch (error) {
    if (isDuplicateEmail(error)) return { ok: false, state: { ...state, message: messages.duplicate, duplicate: true } };
    logAuthFailure();
    return { ok: false, state: { ...state, message: messages.failure } };
  }
}

export async function login(input: Credentials, currentToken?: string, repository: AuthRepository = authRepository, context: RateLimitContext = {}): Promise<AuthResult> {
  const state: AuthFormState = { email: input.email };
  try {
    await revokeCurrent(currentToken, repository);
    const { errors, overlong } = validateLogin(input);
    if (Object.keys(errors).length) return { ok: false, state: { ...state, errors } };
    if (overlong) return { ok: false, state: { ...state, message: messages.incorrect } };
    const { ip, limits = rateLimitRepository, now: clock } = context;
    const emailKey = input.email.trim().toLowerCase();
    const wait = await blockedFor([{ rule: LOGIN_EMAIL_LIMIT, key: emailKey }, ...(ip ? [{ rule: LOGIN_IP_LIMIT, key: ip }] : [])], context);
    if (wait !== null) return { ok: false, state: { ...state, message: tooManyAttempts(wait) } };
    const user = await repository.findUser(input.email.trim());
    const correct = await verifyPassword(user?.passwordHash ?? await getDummyHash(), input.password);
    if (!user || !correct) {
      await recordAttempt({ rule: LOGIN_EMAIL_LIMIT, key: emailKey, repository: limits, now: clock });
      if (ip) await recordAttempt({ rule: LOGIN_IP_LIMIT, key: ip, repository: limits, now: clock });
      return { ok: false, state: { ...state, message: messages.incorrect } };
    }
    await clearAttempts({ rule: LOGIN_EMAIL_LIMIT, key: emailKey, repository: limits });
    const token = createToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await repository.login(user.id, { id: sessionId(token), expiresAt }, now);
    return { ok: true, token, expiresAt, user: { id: user.id, email: user.email } };
  } catch {
    logAuthFailure();
    return { ok: false, state: { ...state, message: messages.failure } };
  }
}

/** Errors propagate so callers cannot confuse a database outage with a guest. */
export async function currentUser(token?: string, repository: AuthRepository = authRepository): Promise<AuthUser | null> {
  if (!validToken(token)) return null;
  const found = await repository.findSession(sessionId(token));
  if (!found) return null;
  if (found.expiresAt.getTime() <= Date.now()) {
    await repository.deleteSession(sessionId(token));
    return null;
  }
  return { id: found.user.id, email: found.user.email };
}

export async function logout(token: string | undefined, clearCookie: () => void, repository: AuthRepository = authRepository): Promise<void> {
  try {
    await revokeCurrent(token, repository);
  } catch {
    logAuthFailure();
  } finally {
    clearCookie();
  }
}
