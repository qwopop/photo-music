import type { RateLimitRule } from "../rate-limit";

const MINUTE = 60_000;

/** Change the limits here. Windows must not exceed RETENTION_MS in lib/rate-limit. */
export const LOGIN_EMAIL_LIMIT: RateLimitRule = { scope: "login_email", limit: 5, windowMs: 10 * MINUTE };
export const LOGIN_IP_LIMIT: RateLimitRule = { scope: "login_ip", limit: 20, windowMs: 10 * MINUTE };
export const SIGNUP_IP_LIMIT: RateLimitRule = { scope: "signup_ip", limit: 10, windowMs: 60 * MINUTE };
