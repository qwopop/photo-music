import "server-only";

import { randomBytes } from "node:crypto";
import { UploadError } from "./errors";
import { MAX_RETAINED_BYTES, MAX_RETAINED_UPLOADS, UPLOAD_TTL_MS } from "./limits";
import type { ImageMimeType, ValidatedImage } from "./validate";

export interface UploadMetadata {
  id: string;
  mimeType: ImageMimeType;
  size: number;
  expiresAt: string;
}

export interface ConsumedUpload extends ValidatedImage {
  size: number;
}

interface Entry {
  image: ValidatedImage;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface StoreOptions {
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Private process memory, bounded independently by original image bytes and entry count. */
export class TemporaryUploadStore {
  private readonly entries = new Map<string, Entry>();
  private retainedBytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: StoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_RETAINED_BYTES;
    this.maxEntries = options.maxEntries ?? MAX_RETAINED_UPLOADS;
    this.ttlMs = options.ttlMs ?? UPLOAD_TTL_MS;
    this.now = options.now ?? Date.now;
    for (const limit of [this.maxBytes, this.maxEntries, this.ttlMs]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid upload store limit.");
    }
  }

  put(image: ValidatedImage): UploadMetadata {
    this.removeExpired();
    if (
      this.entries.size >= this.maxEntries ||
      image.bytes.length > this.maxBytes - this.retainedBytes
    ) {
      throw new UploadError("UPLOAD_CAPACITY_EXCEEDED");
    }

    // 256 random bits. Regenerate on the astronomically unlikely collision.
    let id: string;
    do {
      id = randomBytes(32).toString("base64url");
    } while (this.entries.has(id));
    const expiresAt = this.now() + this.ttlMs;
    // Construct public metadata before mutation so even an invalid injected
    // clock cannot leave behind an entry after a failed put.
    const metadata = { id, mimeType: image.mimeType, size: image.bytes.length, expiresAt: new Date(expiresAt).toISOString() };
    const timer = setTimeout(() => this.release(id), this.ttlMs);
    timer.unref();
    this.entries.set(id, { image, expiresAt, timer });
    this.retainedBytes += image.bytes.length;

    return metadata;
  }

  /** Atomically remove before returning original bytes. Invalid/expired IDs return undefined. */
  consume(id: string): ConsumedUpload | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.release(id);
    if (entry.expiresAt <= this.now()) return undefined;
    return { ...entry.image, size: entry.image.bytes.length };
  }

  /** Non-consuming read, so a failed save can be retried with the same handle. Invalid/expired IDs return undefined. */
  peek(id: string): ConsumedUpload | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.release(id);
      return undefined;
    }
    return { ...entry.image, size: entry.image.bytes.length };
  }

  /** Idempotent removal; safe for unknown, already consumed, released, or expired IDs. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.retainedBytes -= entry.image.bytes.length;
    clearTimeout(entry.timer);
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.release(id);
    }
  }
}

// Preserve one store across Next.js development reloads and server route bundles in this process.
const processGlobals = globalThis as typeof globalThis & { photoMusicUploads?: TemporaryUploadStore };
export const uploadStore = processGlobals.photoMusicUploads ??= new TemporaryUploadStore();

/** For future server-side analysis only; never expose these operations as a photo GET route. */
export function consumeUpload(id: string): ConsumedUpload | undefined {
  return uploadStore.consume(id);
}

export function releaseUpload(id: string): void {
  uploadStore.release(id);
}
