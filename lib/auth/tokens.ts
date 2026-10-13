import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "photo_music_session";
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_ATTRIBUTES = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

export function createToken(): string { return randomBytes(32).toString("base64url"); }
export function validToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}
export function sessionId(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
