import "server-only";

const failures = {
  INVALID_UPLOAD: [400, "Send exactly one image file using multipart/form-data."],
  INVALID_IMAGE: [415, "Choose a valid JPEG, PNG, or WebP image."],
  FILE_TOO_LARGE: [413, "The image must be at most 10 MiB."],
  REQUEST_TOO_LARGE: [413, "The upload request is too large."],
  UPLOAD_CAPACITY_EXCEEDED: [503, "Uploads are temporarily full. Please try again shortly."],
  UPLOAD_FAILED: [500, "The image could not be uploaded. Please try again."],
} as const;

export type UploadErrorCode = keyof typeof failures;

/** Carries only fixed, public text, never an underlying parser/decoder error. */
export class UploadError extends Error {
  readonly status: number;

  constructor(readonly code: UploadErrorCode) {
    const [status, message] = failures[code];
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export function uploadErrorResponse(error: unknown): Response {
  const safe = error instanceof UploadError ? error : new UploadError("UPLOAD_FAILED");
  return Response.json(
    { error: { code: safe.code, message: safe.message } },
    { status: safe.status, headers: { "Cache-Control": "no-store" } },
  );
}
