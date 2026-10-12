import "server-only";

import { UploadError } from "./errors";
import { MAX_FILE_BYTES, MAX_REQUEST_BYTES } from "./limits";

/** Limit actual stream bytes, regardless of the caller's Content-Length declaration. */
async function readBoundedBody(request: Request): Promise<Buffer> {
  if (!request.body) throw new UploadError("INVALID_UPLOAD");
  const reader = request.body.getReader();
  // A fixed allocation also bounds bookkeeping: millions of tiny chunks cannot
  // grow an array of Buffer objects far beyond the request's byte budget.
  const body = Buffer.allocUnsafe(MAX_REQUEST_BYTES);
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_REQUEST_BYTES - size) {
        // Never retain an over-limit chunk or ask for another chunk. Cancellation may
        // fail on a disconnected client; the original safe size error still wins.
        void reader.cancel().catch(() => {});
        throw new UploadError("REQUEST_TOO_LARGE");
      }
      body.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError("INVALID_UPLOAD");
  } finally {
    reader.releaseLock();
  }

  // The uninitialized tail never goes to the parser or any response.
  return body.subarray(0, size);
}

/** Multipart parsing receives only a completed, bounded in-memory request body. */
export async function readImageFile(request: Request): Promise<Buffer> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) {
    throw new UploadError("INVALID_UPLOAD");
  }
  const body = await readBoundedBody(request);
  let form: FormData;
  try {
    // Passing no Content-Length avoids trusting inaccurate incoming declarations.
    form = await new Request("http://localhost/upload", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new UploadError("INVALID_UPLOAD");
  }

  const fields = [...form.entries()];
  if (fields.length !== 1 || fields[0][0] !== "image" || typeof fields[0][1] === "string") {
    throw new UploadError("INVALID_UPLOAD");
  }
  const file = fields[0][1];
  if (file.size > MAX_FILE_BYTES) throw new UploadError("FILE_TOO_LARGE");
  return Buffer.from(await file.arrayBuffer());
}
