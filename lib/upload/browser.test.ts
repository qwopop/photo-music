import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_MIME_TYPES,
  GENERIC_UPLOAD_ERROR,
  buildUploadBody,
  checkFiles,
  formatFileSize,
  uploadPhoto,
} from "./browser";

const f = (type: string, size: number) => ({ type, size });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("checkFiles", () => {
  it.each(ACCEPTED_MIME_TYPES)("accepts %s", (type) => {
    expect(checkFiles([f(type, 10)]).ok).toBe(true);
  });

  it.each(["image/gif", "image/svg+xml", "image/heic", "application/pdf", "text/plain", ""])(
    "rejects type %j",
    (type) => {
      const r = checkFiles([f(type, 10)]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/JPEG, PNG or WebP/);
    },
  );

  it("rejects an empty file", () => {
    const r = checkFiles([f("image/png", 0)]);
    expect(!r.ok && r.message).toMatch(/empty/);
  });

  it("accepts exactly 10,485,760 bytes and rejects one more", () => {
    expect(checkFiles([f("image/png", 10_485_760)]).ok).toBe(true);
    const r = checkFiles([f("image/png", 10_485_761)]);
    expect(!r.ok && r.message).toMatch(/10 MB/);
  });

  it("rejects more than one file", () => {
    const r = checkFiles([f("image/png", 1), f("image/png", 1)]);
    expect(!r.ok && r.message).toMatch(/one photo at a time/);
  });
});

describe("formatFileSize", () => {
  it("uses KB and MB", () => {
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
  });
});

describe("buildUploadBody", () => {
  it("holds only the image field", () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    const body = buildUploadBody(file);
    expect([...body.keys()]).toEqual(["image"]);
    expect((body.get("image") as File).name).toBe("a.png");
  });
});

describe("uploadPhoto", () => {
  const file = new Blob(["x"], { type: "image/png" });
  const run = (res: () => Promise<Response>) =>
    uploadPhoto(file, vi.fn(res) as unknown as typeof fetch);

  it("succeeds on 201 without exposing the handle", async () => {
    const r = await run(async () =>
      json(201, { upload: { id: "secret", mimeType: "image/png", size: 1, expiresAt: "x" } }),
    );
    expect(r).toEqual({ ok: true });
  });

  it("posts one multipart body without a Content-Type header", async () => {
    const fetchMock = vi.fn(async () => json(201, { upload: { id: "a" } }));
    await uploadPhoto(file, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/upload");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it.each([
    ["INVALID_UPLOAD", 400],
    ["INVALID_IMAGE", 415],
    ["FILE_TOO_LARGE", 413],
    ["REQUEST_TOO_LARGE", 413],
    ["UPLOAD_CAPACITY_EXCEEDED", 503],
    ["UPLOAD_FAILED", 500],
  ])("shows the server message for %s", async (code, status) => {
    const r = await run(async () =>
      json(status, { error: { code, message: `msg ${code}` } }),
    );
    expect(r).toEqual({ ok: false, message: `msg ${code}` });
  });

  it("uses the generic message for unusable responses", async () => {
    const generic = { ok: false, message: GENERIC_UPLOAD_ERROR };
    expect(await run(async () => new Response("<html>oops</html>", { status: 502 }))).toEqual(generic);
    expect(await run(async () => new Response("{not json", { status: 500 }))).toEqual(generic);
    expect(await run(async () => json(201, { upload: {} }))).toEqual(generic);
    expect(await run(async () => json(200, { ok: true }))).toEqual(generic);
    expect(await run(async () => json(500, { error: { code: "WEIRD", message: "x" } }))).toEqual(generic);
    expect(await run(async () => { throw new TypeError("Failed to fetch"); })).toEqual(generic);
  });
});
