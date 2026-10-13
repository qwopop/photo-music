export const RATE_LIMIT_MAX_REQUESTS = 10;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_MAX_IPS = 10_000;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface LimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  maxIps?: number;
  now?: () => number;
}

/** In-memory sliding-window limiter per key. Not shared across server instances (#48). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxIps: number;
  private readonly now: () => number;

  constructor(options: LimiterOptions = {}) {
    this.maxRequests = options.maxRequests ?? RATE_LIMIT_MAX_REQUESTS;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.maxIps = options.maxIps ?? RATE_LIMIT_MAX_IPS;
    this.now = options.now ?? Date.now;
  }

  /** Records the request when allowed. Rejected requests are not recorded. */
  check(key: string): RateLimitResult {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => time > now - this.windowMs);
    if (recent.length === 0) {
      this.hits.delete(key);
      if (this.hits.size >= this.maxIps) this.removeExpired(now);
      if (this.hits.size >= this.maxIps) return { allowed: false, retryAfterSeconds: this.retryAfterForFullTable(now) };
    }
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  private removeExpired(now: number): void {
    for (const [key, times] of this.hits) {
      if (times[times.length - 1] <= now - this.windowMs) this.hits.delete(key);
    }
  }

  private retryAfterForFullTable(now: number): number {
    let soonest = Infinity;
    for (const times of this.hits.values()) soonest = Math.min(soonest, times[times.length - 1] + this.windowMs);
    return Math.max(1, Math.ceil((soonest - now) / 1000));
  }
}

const processGlobals = globalThis as typeof globalThis & { photoMusicAnalyzeLimiter?: RateLimiter };
export const analyzeRateLimiter = (processGlobals.photoMusicAnalyzeLimiter ??= new RateLimiter());
