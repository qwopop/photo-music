import { afterEach, describe, expect, it, vi } from "vitest";
import { TemporaryUploadStore } from "./store";
import { UPLOAD_TTL_MS } from "./limits";

const image = { bytes: Buffer.from([1, 2, 3]), mimeType: "image/png" as const };

afterEach(() => vi.useRealTimers());

describe("temporary uploads", () => {
  it("returns only metadata with unique 256-bit handles, and consumes original bytes once", () => {
    const store = new TemporaryUploadStore();
    const first = store.put(image);
    const second = store.put(image);
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.id).not.toBe(first.id);
    expect(Object.keys(first).sort()).toEqual(["expiresAt", "id", "mimeType", "size"]);
    expect(store.consume(first.id)).toEqual({ ...image, size: 3 });
    expect(store.consume(first.id)).toBeUndefined();
    store.release(second.id);
  });

  it("releases idempotently and treats unknown IDs safely", () => {
    const store = new TemporaryUploadStore();
    const { id } = store.put(image);
    store.release(id);
    store.release(id);
    store.release("unknown");
    expect(store.consume(id)).toBeUndefined();
    expect(store.consume("unknown")).toBeUndefined();
  });

  it("expires exactly ten minutes after acceptance without another request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new TemporaryUploadStore();
    const first = store.put(image);
    expect(first.expiresAt).toBe("2026-01-01T00:10:00.000Z");
    const beforeDeadline = store.put(image);
    vi.advanceTimersByTime(UPLOAD_TTL_MS - 1);
    expect(store.consume(beforeDeadline.id)?.bytes).toEqual(image.bytes);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.consume(first.id)).toBeUndefined();
  });

  it("checks expiration against an injected clock even before its timer fires", () => {
    let now = 1000;
    const store = new TemporaryUploadStore({ now: () => now, ttlMs: 100 });
    const { id } = store.put(image);
    now = 1100;
    expect(store.consume(id)).toBeUndefined();
  });

  it("bounds entry count and restores capacity after consume and release", () => {
    const store = new TemporaryUploadStore({ maxEntries: 1 });
    const first = store.put(image);
    expect(() => store.put(image)).toThrowError(expect.objectContaining({ code: "UPLOAD_CAPACITY_EXCEEDED" }));
    store.consume(first.id);
    const second = store.put(image);
    store.release(second.id);
    const third = store.put(image);
    store.release(third.id);
  });

  it("bounds retained bytes inclusively without retaining rejected uploads", () => {
    const store = new TemporaryUploadStore({ maxBytes: 6 });
    const first = store.put(image);
    const second = store.put(image);
    expect(() => store.put(image)).toThrowError(expect.objectContaining({ code: "UPLOAD_CAPACITY_EXCEEDED" }));
    store.release(first.id);
    const third = store.put(image);
    store.release(second.id);
    store.release(third.id);
    const full = store.put({ ...image, bytes: Buffer.alloc(6) });
    store.release(full.id);
    expect(() => store.put({ ...image, bytes: Buffer.alloc(7) })).toThrowError(expect.objectContaining({ code: "UPLOAD_CAPACITY_EXCEEDED" }));
    const afterRejected = store.put({ ...image, bytes: Buffer.alloc(6) });
    store.release(afterRejected.id);
  });

  it("expiry autonomously restores capacity and timers do not keep the process alive", () => {
    vi.useFakeTimers();
    const store = new TemporaryUploadStore({ maxEntries: 1, ttlMs: 20 });
    store.put(image);
    vi.advanceTimersByTime(20);
    expect(vi.getTimerCount()).toBe(0);
    const { id } = store.put(image);
    store.release(id);
  });

  it("unrefs real expiration timers", () => {
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const store = new TemporaryUploadStore();
    const { id } = store.put(image);
    expect(schedule.mock.results[0].value.hasRef()).toBe(false);
    store.release(id);
    schedule.mockRestore();
  });

  it("sweeps entries expired by the injected clock before admitting another upload", () => {
    let now = 0;
    const store = new TemporaryUploadStore({ now: () => now, maxBytes: 3, maxEntries: 1, ttlMs: 100 });
    const first = store.put(image);
    now = 100;
    const second = store.put(image);
    expect(store.consume(first.id)).toBeUndefined();
    store.release(second.id);
  });
});
