/**
 * Browser-safe helpers for the home page upload form. Nothing here may import
 * server-only modules. The server stays the authority on file contents.
 */
import { MAX_FILE_BYTES } from "./limits";

export const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const FILE_INPUT_ACCEPT = ACCEPTED_MIME_TYPES.join(",");

export const UPLOAD_ENDPOINT = "/api/upload";

export const GENERIC_UPLOAD_ERROR =
  "The photo couldn't be uploaded. Please try again.";

export const UNREADABLE_PHOTO_ERROR =
  "This photo could not be read. The file may be damaged.";

export const UPLOAD_SUCCESS_MESSAGE = "Your photo was uploaded.";

const DOCUMENTED_ERROR_CODES = [
  "INVALID_UPLOAD",
  "INVALID_IMAGE",
  "FILE_TOO_LARGE",
  "REQUEST_TOO_LARGE",
  "UPLOAD_CAPACITY_EXCEEDED",
  "UPLOAD_FAILED",
];

type FileLike = { type: string; size: number };

export type FileCheck<T> =
  | { ok: true; file: T }
  | { ok: false; message: string };

export function checkFiles<T extends FileLike>(
  files: ArrayLike<T>,
): FileCheck<T> {
  if (files.length > 1) {
    return { ok: false, message: "Please choose one photo at a time." };
  }
  const file = files[0];
  if (!file) {
    return { ok: false, message: "Please choose a photo." };
  }
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return {
      ok: false,
      message: "Unsupported file type. Please choose a JPEG, PNG or WebP photo.",
    };
  }
  if (file.size === 0) {
    return { ok: false, message: "This file is empty. Please choose another photo." };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      message: "This photo is larger than 10 MB. Please choose a smaller one.",
    };
  }
  return { ok: true, file };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The request body: exactly one field, `image`. */
export function buildUploadBody(file: Blob): FormData {
  const body = new FormData();
  body.append("image", file);
  return body;
}

export type UploadResult = { ok: true } | { ok: false; message: string };

const failure = (message: string): UploadResult => ({ ok: false, message });

/** Turns a response into a result; never exposes the upload handle. */
export async function interpretResponse(
  response: Pick<Response, "status" | "json">,
): Promise<UploadResult> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return failure(GENERIC_UPLOAD_ERROR);
  }
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  const root = record(data);

  if (response.status === 201) {
    const upload = record(root?.upload);
    if (upload && typeof upload.id === "string" && upload.id !== "") {
      return { ok: true };
    }
    return failure(GENERIC_UPLOAD_ERROR);
  }

  const error = record(root?.error);
  if (
    error &&
    typeof error.code === "string" &&
    DOCUMENTED_ERROR_CODES.includes(error.code) &&
    typeof error.message === "string" &&
    error.message !== ""
  ) {
    return failure(error.message);
  }
  return failure(GENERIC_UPLOAD_ERROR);
}

export async function uploadPhoto(
  file: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  try {
    const response = await fetchImpl(UPLOAD_ENDPOINT, {
      method: "POST",
      body: buildUploadBody(file),
    });
    return await interpretResponse(response);
  } catch {
    return failure(GENERIC_UPLOAD_ERROR);
  }
}
