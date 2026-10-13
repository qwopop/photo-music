import { and, count, eq, gt, lte, min } from "drizzle-orm";
import { getDb } from "../db";
import { authAttempts } from "../db/schema";
import type { RateLimitRepository } from "./index";

/** Nothing connects until a method is called during a request. */
export const rateLimitRepository: RateLimitRepository = {
  async count(scope, keyHash, since) {
    const [row] = await getDb().select({ count: count(), oldest: min(authAttempts.createdAt) }).from(authAttempts)
      .where(and(eq(authAttempts.scope, scope), eq(authAttempts.keyHash, keyHash), gt(authAttempts.createdAt, since)));
    return { count: row.count, oldest: row.oldest ? new Date(row.oldest) : null };
  },
  async add(scope, keyHash, at) {
    await getDb().insert(authAttempts).values({ scope, keyHash, createdAt: at });
  },
  async deleteBefore(cutoff) {
    await getDb().delete(authAttempts).where(lte(authAttempts.createdAt, cutoff));
  },
  async clear(scope, keyHash) {
    await getDb().delete(authAttempts).where(and(eq(authAttempts.scope, scope), eq(authAttempts.keyHash, keyHash)));
  },
};
