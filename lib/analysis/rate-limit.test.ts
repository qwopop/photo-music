import { describe, expect, it } from "vitest";
import {
  ANALYSIS_REQUEST_LIMIT,
  ANALYSIS_WINDOW_MS,
  AnalysisRateLimiter,
  MAX_TRACKED_ANALYSIS_IPS,
} from "./rate-limit";

describe("analysis rate limiter", () => {
  it("uses the documented limits and permits ten requests per rolling window", () => {
    let now = 0;
    const limiter = new AnalysisRateLimiter({ now: () => now });
    expect(ANALYSIS_REQUEST_LIMIT).toBe(10);
    expect(ANALYSIS_WINDOW_MS).toBe(600_000);
    expect(MAX_TRACKED_ANALYSIS_IPS).toBe(10_000);
    for (let index = 0; index < 10; index += 1) expect(limiter.check("192.0.2.1").allowed).toBe(true);
    expect(limiter.check("192.0.2.1")).toEqual({ allowed: false, retryAfterSeconds: 600 });
    now = ANALYSIS_WINDOW_MS;
    expect(limiter.check("192.0.2.1")).toEqual({ allowed: true });
  });

  it("returns the remaining time in whole seconds and keeps other IPs independent", () => {
    let now = 100;
    const limiter = new AnalysisRateLimiter({ maxRequests: 1, windowMs: 2500, now: () => now });
    expect(limiter.check("192.0.2.1").allowed).toBe(true);
    now = 601;
    expect(limiter.check("192.0.2.1")).toEqual({ allowed: false, retryAfterSeconds: 2 });
    expect(limiter.check("192.0.2.2")).toEqual({ allowed: true });
    now = 2600;
    expect(limiter.check("192.0.2.1")).toEqual({ allowed: true });
  });

  it("drops expired entries before enforcing the bounded IP cap", () => {
    let now = 0;
    const limiter = new AnalysisRateLimiter({ maxRequests: 1, windowMs: 100, maxTrackedIps: 2, now: () => now });
    expect(limiter.check("one").allowed).toBe(true);
    expect(limiter.check("two").allowed).toBe(true);
    expect(limiter.check("three")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.trackedIpCount).toBe(2);
    now = 100;
    expect(limiter.check("three")).toEqual({ allowed: true });
    expect(limiter.trackedIpCount).toBe(1);
  });

  it("rejects invalid limits", () => {
    expect(() => new AnalysisRateLimiter({ maxRequests: 0 })).toThrow("Invalid analysis rate limit.");
  });
});
