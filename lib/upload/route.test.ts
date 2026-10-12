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
const imageFixture = (name: string) => readFileSync(new URL(`../image/fixtures/${name}`, import.meta.url));
const incompletePng = {
  "missing IEND": imageFixture("missing-iend.png"),
  "truncated IEND": imageFixture("truncated-iend.png"),
};
const apng = {
  "animated default image": imageFixture("apng-default-frame.apng"),
  "separate fallback default image": readFileSync(new URL("../palette/fixtures/default-image.apng", import.meta.url)),
  "missing animation controls": imageFixture("apng-missing-controls.apng"),
  "corrupt later frame data": imageFixture("apng-corrupt-later-frame.apng"),
  "over-aggregate animation": imageFixture("apng-over-aggregate.apng"),
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

  /** Spies on sharp's real decoder construction and decoding methods without changing them. */
  function spyOnDecoder() {
    const prototype = sharp.prototype as unknown as Record<"_createInputDescriptor" | "metadata" | "raw", () => unknown>;
    return [vi.spyOn(prototype, "_createInputDescriptor"), vi.spyOn(prototype, "metadata"), vi.spyOn(prototype, "raw")];
  }

  async function expectRejectedBeforeDecodeOrStore(request: Request) {
    const decoder = spyOnDecoder();
    const retain = vi.spyOn(uploadStore, "put");
    const { response, body } = await upload(request);
    expect(response.status).toBe(415);
    expect(body).toEqual({ error: { code: "INVALID_IMAGE", message: "Choose a valid JPEG, PNG, or WebP image." } });
    for (const spy of [...decoder, retain]) expect(spy).not.toHaveBeenCalled();
  }

  it.each(Object.entries(incompletePng))("rejects a PNG with %s although sharp alone recovers its pixels", async (_, bytes) => {
    await expect(sharp(bytes, { failOn: "warning" }).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expectRejectedBeforeDecodeOrStore(multipart(bytes, "photo.png", "image/png"));
  });

  it("rejects a PNG with a corrupt chunk CRC before decoding or retention", async () => {
    const bytes = Buffer.from(fixtures.png);
    bytes[32] ^= 1; // last byte of the IHDR chunk's CRC
    await expectRejectedBeforeDecodeOrStore(multipart(bytes, "photo.png", "image/png"));
  });

  it.each(Object.entries(apng).flatMap(([name, bytes]) => [
    [name, bytes, "animation.png", "image/png"],
    [name, bytes, "animation.apng", "image/apng"],
    [name, bytes, "photo.jpg", "image/jpeg"],
    [name, bytes, "notes.txt", "text/plain"],
  ] as const))("rejects APNG with %s sent as %s (%s) before decoding or retention", async (_, bytes, name, type) => {
    await expectRejectedBeforeDecodeOrStore(multipart(bytes, name, type));
  });

  it("cannot be switched to the internal APNG default-image policy by a client", async () => {
    const validate = vi.spyOn(validation, "validateImage");
    const form = new FormData();
    form.append("image", new File([new Uint8Array(apng["animated default image"])], "default-image.png", { type: "image/png" }));
    const request = new Request("http://localhost/api/upload?pngAnimation=default-image", {
      method: "POST", body: form, headers: { "X-Png-Animation": "default-image" },
    });
    await expectRejectedBeforeDecodeOrStore(request);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0]).toHaveLength(1);

    const withField = new FormData();
    withField.append("image", new File([new Uint8Array(apng["animated default image"])], "a.png", { type: "image/png" }));
    withField.append("pngAnimation", "default-image");
    await expectError(new Request("http://localhost/api/upload", { method: "POST", body: withField }), 400, "INVALID_UPLOAD");
  });

  it("calls the shared validator with the public default policy for accepted uploads too", async () => {
    const validate = vi.spyOn(validation, "validateImage");
    const { response } = await upload(multipart(fixtures.png, "photo.png", "image/png"));
    expect(response.status).toBe(201);
    expect(validate.mock.calls).toEqual([[fixtures.png]]);
  });

  it("accepts ordinary static PNG variations after the container guard and genuine decoding", async () => {
    const variations = [
      await sharp(fixtures.png).png({ palette: true, colours: 2 }).toBuffer(),
      await sharp(fixtures.png).png({ progressive: true }).toBuffer(),
      await sharp(fixtures.png).withMetadata().png().toBuffer(),
      Buffer.concat([fixtures.png, Buffer.alloc(16)]),
    ];
    for (const bytes of variations) {
      const decode = vi.spyOn(sharp.prototype, "raw");
      const { response, body } = await upload(multipart(bytes, "photo.png", "image/png"));
      expect(response.status).toBe(201);
      expect(body.upload).toMatchObject({ mimeType: "image/png", size: bytes.length });
      expect(decode).toHaveBeenCalled();
      expect(consumeUpload(body.upload.id)?.bytes.equals(bytes)).toBe(true);
      vi.restoreAllMocks();
    }
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
