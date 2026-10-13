import { and, eq, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { lower, sessions, users } from "../db/schema";

export interface AuthUser { id: string; email: string }
export interface PasswordUser extends AuthUser { passwordHash: string }
export interface NewSession { id: string; expiresAt: Date }
export interface SessionUser { user: AuthUser; expiresAt: Date }
export interface AuthRepository {
  signup(email: string, passwordHash: string, session: NewSession): Promise<AuthUser>;
  findUser(email: string): Promise<PasswordUser | null>;
  login(userId: string, session: NewSession, now: Date): Promise<void>;
  findSession(id: string): Promise<SessionUser | null>;
  deleteSession(id: string): Promise<void>;
}

/** Nothing connects until a method is called during a request. */
export const authRepository: AuthRepository = {
  async signup(email, passwordHash, session) {
    return getDb().transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, passwordHash }).returning({ id: users.id, email: users.email });
      await tx.insert(sessions).values({ ...session, userId: user.id });
      return user;
    });
  },
  async findUser(email) {
    const [user] = await getDb().select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users).where(eq(lower(users.email), sql`lower(${email})`)).limit(1);
    return user ?? null;
  },
  async login(userId, session, now) {
    await getDb().transaction(async (tx) => {
      await tx.delete(sessions).where(and(eq(sessions.userId, userId), lte(sessions.expiresAt, now)));
      await tx.insert(sessions).values({ ...session, userId });
    });
  },
  async findSession(id) {
    const [result] = await getDb().select({ user: { id: users.id, email: users.email }, expiresAt: sessions.expiresAt })
      .from(sessions).innerJoin(users, eq(sessions.userId, users.id)).where(eq(sessions.id, id)).limit(1);
    return result ?? null;
  },
  async deleteSession(id) {
    await getDb().delete(sessions).where(eq(sessions.id, id));
  },
};
