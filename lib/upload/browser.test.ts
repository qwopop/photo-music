import { describe, expect, it, vi } from "vitest";
import {
  ACCEPT_ATTRIBUTE,
  ACCEPTED_IMAGE_TYPES,
  EMPTY_FILE_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  GENERIC_UPLOAD_ERROR_MESSAGE,
  MAX_FILE_SIZE_LABEL,
  MULTIPLE_FILES_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
  UPLOAD_ENDPOINT,
  buildUploadBody,
  checkFile,
  checkFiles,
  formatFileSize,
  readUploadResponse,
  uploadPhoto,
} from "./browser";
// Server-only modules, imported here only to check the browser helper
// against the real server responses. Client code never imports them.
import { UploadError, uploadErrorResponse, type UploadErrorCode } from "./errors";
import { MAX_FILE_BYTES } from "./limits";

function photo(size: number, type = "image/jpeg", name = "synthetic.jpg"): File {
  return new File([new Uint8Array(size)], name, { type });
}

const uploaded = {
  upload: {
    id: "synthetic-handle-for-tests",
    mimeType: "image/jpeg",
    size: 3,
    expiresAt: "2026-01-01T00:10:00.000Z",
  },
};

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>(async () => response);
}

describe("accepted types", () => {
  it("are exactly JPEG, PNG and WebP, also in the accept attribute", () => {
    expect(ACCEPTED_IMAGE_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(ACCEPT_ATTRIBUTE).toBe("image/jpeg,image/png,image/webp");
  });

  it.each(ACCEPTED_IMAGE_TYPES)("accepts %s", (type) => {
    expect(checkFile(photo(3, type))).toBeNull();
    const file = photo(3, type);
    expect(checkFiles([file])).toEqual({ kind: "accepted", file });
  });

  it.each([
    ["GIF", "image/gif"],
    ["SVG", "image/svg+xml"],
    ["HEIC", "image/heic"],
    ["PDF", "application/pdf"],
    ["text", "text/plain"],
    ["APNG declared as such", "image/apng"],
    ["no recognised type (for example a folder)", ""],
  ])("rejects %s, naming the supported formats", (_label, type) => {
    expect(checkFile(photo(3, type))).toBe(UNSUPPORTED_TYPE_MESSAGE);
    expect(checkFiles([photo(3, type)])).toEqual({ kind: "rejected", message: UNSUPPORTED_TYPE_MESSAGE });
    expect(UNSUPPORTED_TYPE_MESSAGE).toMatch(/JPEG, PNG or WebP/);
  });

  it("reports the type before the size, so an empty folder entry gets the type message", () => {
    expect(checkFile({ type: "", size: 0 })).toBe(UNSUPPORTED_TYPE_MESSAGE);
  });
});

describe("file size", () => {
  it("rejects a 0-byte file as empty", () => {
    expect(checkFile(photo(0))).toBe(EMPTY_FILE_MESSAGE);
    expect(EMPTY_FILE_MESSAGE).toMatch(/empty/);
  });

  it("accepts exactly 10,485,760 bytes", () => {
    expect(MAX_FILE_BYTES).toBe(10_485_760);
    const file = photo(MAX_FILE_BYTES, "image/png");
    expect(checkFile(file)).toBeNull();
    expect(checkFiles([file])).toEqual({ kind: "accepted", file });
  });

  it("rejects 10,485,761 bytes, stating the 10 MB limit", () => {
    expect(checkFile(photo(MAX_FILE_BYTES + 1, "image/png"))).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(MAX_FILE_SIZE_LABEL).toBe("10 MB");
    expect(FILE_TOO_LARGE_MESSAGE).toContain("10 MB");
  });
});

describe("file count", () => {
  it("ignores a drop without files, such as text or a link", () => {
    expect(checkFiles([])).toEqual({ kind: "none" });
  });

  it("rejects more than one file and selects none of them", () => {
    const result = checkFiles([photo(3), photo(3, "image/png")]);
    expect(result).toEqual({ kind: "rejected", message: MULTIPLE_FILES_MESSAGE });
    expect(MULTIPLE_FILES_MESSAGE).toMatch(/one photo at a time/);
  });

  it("rejects several files even when each one is valid on its own", () => {
    expect(checkFiles([photo(3), photo(3), photo(3)]).kind).toBe("rejected");
  });
});

describe("formatFileSize", () => {
  it.each([
    [1, "0.1 KB"],
    [270, "0.3 KB"],
    [1024, "1 KB"],
    [512_000, "500 KB"],
    [1_048_575, "1 MB"],
    [1_048_576, "1 MB"],
    [2_516_582, "2.4 MB"],
    [MAX_FILE_BYTES, "10 MB"],
  ])("formats %i bytes as %s", (bytes, label) => {
    expect(formatFileSize(bytes)).toBe(label);
  });
});

describe("buildUploadBody", () => {
  it("holds only the image field, with the selected file", () => {
    const file = photo(3, "image/webp", "synthetic.webp");
    const entries = [...buildUploadBody(file).entries()];
    expect(entries).toHaveLength(1);
    const [name, value] = entries[0];
    expect(name).toBe("image");
    expect(value).toBeInstanceOf(File);
    expect(value).toMatchObject({ name: "synthetic.webp", type: "image/webp", size: 3 });
  });
});

describe("uploadPhoto", () => {
  it("sends one POST to /api/upload whose body holds only the image field", async () => {
    const send = fetchReturning(Response.json(uploaded, { status: 201 }));
    const file = photo(3);
    await uploadPhoto(file, { fetch: send });

    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe(UPLOAD_ENDPOINT);
    expect(url).toBe("/api/upload");
    expect(init?.method).toBe("POST");
    // fetch must add the multipart Content-Type with its boundary itself.
    expect(init?.headers).toBeUndefined();
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    const entries = [...(body as FormData).entries()];
    expect(entries.map(([name]) => name)).toEqual(["image"]);
    expect(entries[0][1]).toBe(file);
  });

  it("produces a multipart/form-data request that the server can parse", async () => {
    const file = photo(3, "image/png", "synthetic.png");
    const request = new Request("http://localhost/api/upload", { method: "POST", body: buildUploadBody(file) });
    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = await request.formData();
    expect([...form.keys()]).toEqual(["image"]);
  });

  it("passes the abort signal on", async () => {
    const send = fetchReturning(Response.json(uploaded, { status: 201 }));
    const controller = new AbortController();
    await uploadPhoto(photo(3), { fetch: send, signal: controller.signal });
    expect(send.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("reports success on HTTP 201 with an upload id", async () => {
    const result = await uploadPhoto(photo(3), { fetch: fetchReturning(Response.json(uploaded, { status: 201 })) });
    expect(result).toEqual({ ok: true, uploadId: "synthetic-handle-for-tests" });
  });

  const documentedErrors: [UploadErrorCode, number][] = [
    ["INVALID_UPLOAD", 400],
    ["INVALID_IMAGE", 415],
    ["FILE_TOO_LARGE", 413],
    ["REQUEST_TOO_LARGE", 413],
    ["UPLOAD_CAPACITY_EXCEEDED", 503],
    ["UPLOAD_FAILED", 500],
  ];

  it.each(documentedErrors)("shows the server's message for %s (HTTP %i)", async (code, status) => {
    const response = uploadErrorResponse(new UploadError(code));
    expect(response.status).toBe(status);
    const { message } = new UploadError(code);
    const result = await uploadPhoto(photo(3), { fetch: fetchReturning(response) });
    expect(result).toEqual({ ok: false, message });
    expect(message).not.toBe(GENERIC_UPLOAD_ERROR_MESSAGE);
  });

  it("shows the server's capacity message on HTTP 503", async () => {
    const response = Response.json(
      { error: { code: "UPLOAD_CAPACITY_EXCEEDED", message: "Uploads are temporarily full. Please try again shortly." } },
      { status: 503 },
    );
    expect(await uploadPhoto(photo(3), { fetch: fetchReturning(response) })).toEqual({
      ok: false,
      message: "Uploads are temporarily full. Please try again shortly.",
    });
  });

  const generic = { ok: false, message: GENERIC_UPLOAD_ERROR_MESSAGE };

  it.each([
    [
      "a non-JSON body (HTML error page)",
      () => new Response("<!DOCTYPE html><h1>502 Bad Gateway</h1>", { status: 502, headers: { "Content-Type": "text/html" } }),
    ],
    [
      "a malformed JSON body",
      () => new Response('{"error": {"code": "INVALID_IMAGE", "message": ', { status: 415, headers: { "Content-Type": "application/json" } }),
    ],
    ["an empty error body", () => new Response(null, { status: 500 })],
    ["JSON without the error shape", () => Response.json({ detail: "Internal stack trace" }, { status: 500 })],
    ["an error whose message is not a string", () => Response.json({ error: { code: "INVALID_IMAGE", message: 42 } }, { status: 415 })],
    ["an error without a code", () => Response.json({ error: { message: "Nope" } }, { status: 400 })],
    ["an error with a blank message", () => Response.json({ error: { code: "UPLOAD_FAILED", message: "  " } }, { status: 500 })],
    ["a 201 body without upload.id", () => Response.json({ upload: { mimeType: "image/jpeg" } }, { status: 201 })],
    ["a 201 body with an empty upload.id", () => Response.json({ upload: { id: "" } }, { status: 201 })],
    ["a 201 body with a non-string upload.id", () => Response.json({ upload: { id: 7 } }, { status: 201 })],
    ["a 201 JSON null body", () => Response.json(null, { status: 201 })],
    ["a 201 non-JSON body", () => new Response("Created", { status: 201 })],
    ["an unexpected 200 body", () => Response.json({}, { status: 200 })],
    ["a 200 with an upload id instead of the documented 201", () => Response.json(uploaded, { status: 200 })],
    ["a 2xx body carrying the error shape", () => Response.json({ error: { code: "X", message: "Odd" } }, { status: 200 })],
  ])("shows the generic message for %s", async (_label, makeResponse) => {
    const result = await uploadPhoto(photo(3), { fetch: fetchReturning(makeResponse()) });
    expect(result).toEqual(generic);
  });

  it("shows the generic message when fetch rejects (network failure)", async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await uploadPhoto(photo(3), { fetch: send })).toEqual(generic);
  });

  it("shows the generic message when the request is aborted", async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    expect(await uploadPhoto(photo(3), { fetch: send })).toEqual(generic);
  });

  it("uses the global fetch by default", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(uploaded, { status: 201 }));
    try {
      expect(await uploadPhoto(photo(3))).toEqual({ ok: true, uploadId: "synthetic-handle-for-tests" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBe("/api/upload");
    } finally {
      send.mockRestore();
    }
  });

  it("never puts a status code or raw response text into the generic message", () => {
    expect(GENERIC_UPLOAD_ERROR_MESSAGE).toBe("The photo couldn't be uploaded. Please try again.");
    expect(GENERIC_UPLOAD_ERROR_MESSAGE).not.toMatch(/\d/);
  });
});

describe("readUploadResponse", () => {
  it("reads a real 201 response shape", async () => {
    expect(await readUploadResponse(Response.json(uploaded, { status: 201 }))).toEqual({
      ok: true,
      uploadId: "synthetic-handle-for-tests",
    });
  });
});
