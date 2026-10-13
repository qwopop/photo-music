import { describe, expect, it } from "vitest";
import { checkRateLimit, clearAttempts, formatMinutes, hashKey, recordAttempt, RETENTION_MS } from "./index";
import { memoryRateLimitRepository } from "./memory";

const rule = { scope: "test", limit: 3, windowMs: 10 * 60_000 };

function setup() {
  const repository = memoryRateLimitRepository();
  let time = Date.UTC(2026, 0, 1);
  const now = () => new Date(time);
  const advance = (ms: number) => { time += ms; };
  return { repository, now, advance, call: (key = "a@x.com") => ({ rule, key, repository, now }) };
}

describe("rate limit", () => {
  it("blocks at the limit and reports the wait until the oldest attempt leaves", async () => {
    const { call, advance } = setup();
    for (let i = 0; i < 3; i++) { expect(await checkRateLimit(call())).toEqual({ blocked: false }); await recordAttempt(call()); advance(60_000); }
    expect(await checkRateLimit(call())).toEqual({ blocked: true, retryAfterMs: 7 * 60_000 });
  });
  it("unblocks after the window with no remaining state", async () => {
    const { call, advance, repository } = setup();
    for (let i = 0; i < 3; i++) await recordAttempt(call());
    advance(10 * 60_000 - 1);
    expect((await checkRateLimit(call())).blocked).toBe(true);
    advance(1);
    expect(await checkRateLimit(call())).toEqual({ blocked: false });
    await recordAttempt(call());
    // Old rows stay until retention, but no longer count.
    expect(repository.rows).toHaveLength(4);
    expect(await checkRateLimit(call())).toEqual({ blocked: false });
  });
  it("keeps keys and scopes apart and stores only hashes", async () => {
    const { call, repository } = setup();
    for (let i = 0; i < 3; i++) await recordAttempt(call("a@x.com"));
    expect((await checkRateLimit(call("b@x.com"))).blocked).toBe(false);
    expect((await checkRateLimit({ ...call("a@x.com"), rule: { ...rule, scope: "other" } })).blocked).toBe(false);
    expect(repository.rows.every((row) => row.keyHash === hashKey("a@x.com") && !row.keyHash.includes("a@x.com"))).toBe(true);
  });
  it("clears one key only", async () => {
    const { call } = setup();
    await recordAttempt(call("a")); await recordAttempt(call("b"));
    await clearAttempts(call("a"));
    const { repository } = call("a");
    expect(repository.rows.map((row) => row.keyHash)).toEqual([hashKey("b")]);
  });
  it("deletes rows older than the retention time on later writes", async () => {
    const { call, advance, repository } = setup();
    await recordAttempt(call("old"));
    advance(RETENTION_MS - 1);
    await recordAttempt(call("mid"));
    expect(repository.rows).toHaveLength(2);
    advance(1);
    await recordAttempt(call("new"));
    expect(repository.rows.map((row) => row.keyHash)).toEqual([hashKey("mid"), hashKey("new")]);
  });
});

describe("formatMinutes", () => {
  it.each([[0, "1 minute"], [1, "1 minute"], [60_000, "1 minute"], [60_001, "2 minutes"], [600_000, "10 minutes"]])("%d ms", (ms, text) => {
    expect(formatMinutes(ms)).toBe(text);
  });
});
