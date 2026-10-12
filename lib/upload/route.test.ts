import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../app/api/upload/route";
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS, MAX_REQUEST_BYTES } from "./limits";
import { TemporaryUploadStore, consumeUpload, releaseUpload, uploadStore } from "./store";
import * as validation from "./validate";

const fixtures = {
  jpeg: readFileSync(new URL("./fixtures/sample.jpg", import.meta.url)),
  png: readFileSync(new URL("./fixtures/sample.png", import.meta.url)),
  webp: readFileSync(new URL("./fixtures/sample.webp", import.meta.url)),
  gif: readFileSync(new URL("./fixtures/unsupported.gif", import.meta.url)),
};
const handles: string[] = [];

afterEach(() => {
  for (const id of handles.splice(0)) releaseUpload(id);
  vi.restoreAllMocks();
});

function multipart(bytes: Buffer, name = "photo.jpg", type = "image/jpeg"): Request {
  const form = new FormData();
  form.append("image", new File([new Uint8Array(bytes)], name, { type }));
  return new Request("http://localhost/api/upload", { method: "POST", body: form });
}

async function upload(request: Request) {
  const response = await POST(request);
  const body = await response.json();
  if (body.upload) handles.push(body.upload.id);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { response, body };
}

async function expectError(request: Request, status: number, code: string) {
  const { response, body } = await upload(request);
  expect(response.status).toBe(status);
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe("POST /api/upload", () => {
  it.each(["jpeg", "png", "webp"] as const)("decodes genuine %s and returns private metadata only", async (format) => {
    const start = Date.now();
    const { response, body } = await upload(multipart(fixtures[format]));
    expect(response.status).toBe(201);
    expect(Object.keys(body)).toEqual(["upload"]);
    expect(body.upload).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      mimeType: `image/${format}`,
      size: fixtures[format].length,
      expiresAt: expect.any(String),
    });
    const expiresAt = Date.parse(body.upload.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(start + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(consumeUpload(body.upload.id)?.bytes).toEqual(fixtures[format]);
    expect(consumeUpload(body.upload.id)).toBeUndefined();
  });

  it.each([
    ["png", "photo.jpg", "image/jpeg"],
    ["jpeg", "photo.txt", "text/plain"],
  ] as const)("detects %s despite filename %s and type %s", async (format, name, type) => {
    const { response, body } = await upload(multipart(fixtures[format], name, type));
    expect(response.status).toBe(201);
    expect(body.upload.mimeType).toBe(`image/${format}`);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("private content")],
    ["disguised GIF", fixtures.gif],
    ["JPEG signature", Buffer.from([0xff, 0xd8, 0xff])],
    ["PNG signature", fixtures.png.subarray(0, 8)],
    ["WebP signature", fixtures.webp.subarray(0, 12)],
    ["truncated JPEG", fixtures.jpeg.subarray(0, fixtures.jpeg.length - 25)],
    ["truncated PNG", fixtures.png.subarray(0, Math.floor(fixtures.png.length / 2))],
    ["truncated WebP", fixtures.webp.subarray(0, fixtures.webp.length - 10)],
  ])("rejects %s without retaining anything", async (_, bytes) => {
    const retain = vi.spyOn(uploadStore, "put");
    await expectError(multipart(bytes as Buffer), 415, "INVALID_IMAGE");
    expect(retain).not.toHaveBeenCalled();
  });

  it.each(["jpeg", "png", "webp"] as const)("rejects corrupt %s image pixels", async (format) => {
    const bytes = Buffer.from(fixtures[format]);
    bytes.fill(0xff, Math.floor(bytes.length / 2), bytes.length - 2);
    await expectError(multipart(bytes), 415, "INVALID_IMAGE");
  });

  it("rejects an image above the decode pixel allocation limit", async () => {
    const width = 5001;
    const height = 5000;
    expect(width * height).toBeGreaterThan(MAX_IMAGE_PIXELS);
    const bytes = await sharp({ create: { width, height, channels: 3, background: "blue" } }).png().toBuffer();
    expect(bytes.length).toBeLessThan(MAX_FILE_BYTES);
    await expectError(multipart(bytes), 415, "INVALID_IMAGE");
  });

  it("accepts a decodable file exactly at the 10 MiB inclusive boundary", async () => {
    // JPEG permits trailing data; libvips still fully decodes the original pixels.
    const bytes = Buffer.alloc(MAX_FILE_BYTES);
    fixtures.jpeg.copy(bytes);
    const { response, body } = await upload(multipart(bytes));
    expect(response.status).toBe(201);
    expect(body.upload.size).toBe(MAX_FILE_BYTES);
    expect(consumeUpload(body.upload.id)?.bytes.equals(bytes)).toBe(true);
  });

  it("rejects a file one byte above the file limit before decoding or retention", async () => {
    const decode = vi.spyOn(validation, "validateImage");
    const retain = vi.spyOn(uploadStore, "put");
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    fixtures.jpeg.copy(bytes);
    await expectError(multipart(bytes), 413, "FILE_TOO_LARGE");
    expect(decode).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
  });

  it.each(["missing", "text", "duplicate", "wrong name", "additional file"])("rejects %s image field", async (shape) => {
    const form = new FormData();
    if (shape === "text") form.append("image", "text");
    if (shape === "wrong name") form.append("photo", new File([fixtures.jpeg], "photo.jpg"));
    if (shape === "duplicate" || shape === "additional file") {
      form.append("image", new File([fixtures.jpeg], "photo.jpg"));
      form.append(shape === "duplicate" ? "image" : "other", new File([fixtures.jpeg], "other.jpg"));
    }
    await expectError(new Request("http://localhost/api/upload", { method: "POST", body: form }), 400, "INVALID_UPLOAD");
  });

  it.each([
    ["application/json", "{}"],
    ["multipart/form-data", "missing boundary"],
    ["multipart/form-data; boundary=sample", "malformed data"],
    ["multipart/form-data; boundary=sample", '--sample\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\n\r\ntruncated'],
  ])("handles malformed multipart/type %s safely", async (contentType, body) => {
    await expectError(new Request("http://localhost/api/upload", {
      method: "POST", headers: { "Content-Type": contentType }, body,
    }), 400, "INVALID_UPLOAD");
  });

  it.each([undefined, "1", String(MAX_REQUEST_BYTES * 5)])("enforces the actual stream cap with Content-Length %s", async (length) => {
    const retain = vi.spyOn(uploadStore, "put");
    const decode = vi.spyOn(validation, "validateImage");
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        // Multiple chunks exercise the running total, rather than only one giant body.
        controller.enqueue(new Uint8Array(32 * 1024));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const headers = new Headers({ "Content-Type": "multipart/form-data; boundary=sample" });
    if (length) headers.set("Content-Length", length);
    const request = new Request("http://localhost/api/upload", {
      method: "POST", headers, body: stream, duplex: "half",
    } as RequestInit);
    await expectError(request, 413, "REQUEST_TOO_LARGE");
    expect(cancelled).toBe(true);
    expect(pulled).toBe(MAX_REQUEST_BYTES / (32 * 1024) + 1);
    expect(decode).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
  });

  it("allows a body exactly at the request cap to reach multipart validation", async () => {
    await expectError(new Request("http://localhost/api/upload", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=sample" },
      body: new Uint8Array(MAX_REQUEST_BYTES),
    }), 400, "INVALID_UPLOAD");
  });

  it("returns a structured failure for a disconnected body stream", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private stream content")); } });
    await expectError(new Request("http://localhost/api/upload", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=sample" },
      body: stream, duplex: "half",
    } as RequestInit), 400, "INVALID_UPLOAD");
  });

  it("returns 503 on capacity exhaustion and can upload after release, consume, or expiry", async () => {
    vi.useFakeTimers();
    const smallStore = new TemporaryUploadStore({ maxBytes: fixtures.jpeg.length, maxEntries: 1, ttlMs: 100 });
    vi.spyOn(uploadStore, "put").mockImplementation((image) => smallStore.put(image));
    try {
      const first = await upload(multipart(fixtures.jpeg));
      await expectError(multipart(fixtures.jpeg), 503, "UPLOAD_CAPACITY_EXCEEDED");
      smallStore.release(first.body.upload.id);
      const second = await upload(multipart(fixtures.jpeg));
      expect(second.response.status).toBe(201);
      smallStore.consume(second.body.upload.id);
      const third = await upload(multipart(fixtures.jpeg));
      expect(third.response.status).toBe(201);
      vi.advanceTimersByTime(100);
      const fourth = await upload(multipart(fixtures.jpeg));
      expect(fourth.response.status).toBe(201);
      smallStore.release(fourth.body.upload.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never discloses internal errors, filenames, image content or logs", async () => {
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    vi.spyOn(uploadStore, "put").mockImplementation(() => { throw new Error("secret env value; bearer handle; private content; stack details"); });
    const { response, body } = await upload(multipart(fixtures.jpeg, "private-filename.jpg"));
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: { code: "UPLOAD_FAILED", message: "The image could not be uploaded. Please try again." } });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("GET cannot retrieve bytes and is not cacheable", () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
