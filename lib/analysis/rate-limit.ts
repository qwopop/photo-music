import "server-only";

export const ANALYSIS_REQUEST_LIMIT = 10;
export const ANALYSIS_WINDOW_MS = 10 * 60 * 1000;
export const MAX_TRACKED_ANALYSIS_IPS = 10_000;

interface RateLimitOptions {
  readonly maxRequests?: number;
  readonly windowMs?: number;
  readonly maxTrackedIps?: number;
  readonly now?: () => number;
}

interface Bucket {
  requests: number[];
}

export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export class AnalysisRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedIps: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions = {}) {
    this.maxRequests = options.maxRequests ?? ANALYSIS_REQUEST_LIMIT;
    this.windowMs = options.windowMs ?? ANALYSIS_WINDOW_MS;
    this.maxTrackedIps = options.maxTrackedIps ?? MAX_TRACKED_ANALYSIS_IPS;
    this.now = options.now ?? Date.now;
    for (const limit of [this.maxRequests, this.windowMs, this.maxTrackedIps]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid analysis rate limit.");
    }
  }

  check(ip: string, now = this.now()): RateLimitResult {
    const cutoff = now - this.windowMs;
    for (const [trackedIp, bucket] of this.buckets) {
      bucket.requests = bucket.requests.filter((timestamp) => timestamp > cutoff);
      if (bucket.requests.length === 0) this.buckets.delete(trackedIp);
    }

    const bucket = this.buckets.get(ip);
    if (!bucket && this.buckets.size >= this.maxTrackedIps) {
      return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
    }
    if (bucket && bucket.requests.length >= this.maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.requests[0] + this.windowMs - now) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }

    const requests = bucket?.requests ?? [];
    requests.push(now);
    this.buckets.set(ip, { requests });
    return { allowed: true };
  }

  get trackedIpCount(): number {
    return this.buckets.size;
  }
}

const processGlobals = globalThis as typeof globalThis & {
  photoMusicAnalysisRateLimiter?: AnalysisRateLimiter;
};

export const analysisRateLimiter =
  processGlobals.photoMusicAnalysisRateLimiter ??= new AnalysisRateLimiter();
