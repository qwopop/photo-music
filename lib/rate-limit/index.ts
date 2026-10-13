/**
 * Sliding-window attempt limits backed by a repository (PostgreSQL in the
 * app, memory in tests). Plain TypeScript: the clock is injected, nothing
 * here sleeps or reads the environment.
 *
 * One stored row is one counted attempt. Only a hash of the key is stored.
 */
import { createHash } from "node:crypto";

export interface RateLimitRepository {
  /** Attempts for the key created at or after `since`, and the oldest one's time. */
  count(scope: string, keyHash: string, since: Date): Promise<{ count: number; oldest: Date | null }>;
  add(scope: string, keyHash: string, at: Date): Promise<void>;
  /** Removes every row, of any key, created before `cutoff`. */
  deleteBefore(cutoff: Date): Promise<void>;
  clear(scope: string, keyHash: string): Promise<void>;
}

export interface RateLimitRule {
  scope: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitCall {
  rule: RateLimitRule;
  /** Raw key, such as a lower-cased email or an IP. It is hashed before storage. */
  key: string;
  repository: RateLimitRepository;
  now?: () => Date;
}

export type RateLimitCheck = { blocked: false } | { blocked: true; retryAfterMs: number };

/** Rows at least this old are deleted by every write. Longer than any window in use. */
export const RETENTION_MS = 60 * 60 * 1000;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Read-only: a blocked attempt adds no row. */
export async function checkRateLimit({ rule, key, repository, now = () => new Date() }: RateLimitCall): Promise<RateLimitCheck> {
  const current = now();
  const { count, oldest } = await repository.count(rule.scope, hashKey(key), new Date(current.getTime() - rule.windowMs));
  if (count < rule.limit || !oldest) return { blocked: false };
  return { blocked: true, retryAfterMs: Math.max(0, oldest.getTime() + rule.windowMs - current.getTime()) };
}

/** Counts one attempt and deletes rows older than the retention time. */
export async function recordAttempt({ rule, key, repository, now = () => new Date() }: RateLimitCall): Promise<void> {
  const current = now();
  await repository.add(rule.scope, hashKey(key), current);
  await repository.deleteBefore(new Date(current.getTime() - RETENTION_MS));
}

export async function clearAttempts({ rule, key, repository }: Omit<RateLimitCall, "now">): Promise<void> {
  await repository.clear(rule.scope, hashKey(key));
}

/** "1 minute" or "N minutes", rounded up, at least 1. */
export function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
