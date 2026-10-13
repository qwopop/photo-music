// Browser-safe upload helpers for the home page form. This module must stay
// free of server-only imports (errors, request, validate, store, lib/config,
// sharp): it is bundled into client code. The server stays the authority on
// the real file contents; these checks only save a pointless request.
import { MAX_FILE_BYTES } from "./limits";

/** The only browser-reported types the form accepts, in `accept` order. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Value for the file input's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");

export const UPLOAD_ENDPOINT = "/api/upload";

const KIB = 1024;
const MIB = 1024 * KIB;

function formatAmount(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Formats a size in binary units, as Windows shows file sizes: "512 KB",
 * "2.4 MB". A nonzero size never shows as "0 KB".
 */
export function formatFileSize(bytes: number): string {
  const kib = bytes / KIB;
  if (Math.round(kib * 10) / 10 < KIB) {
    return `${formatAmount(bytes > 0 ? Math.max(kib, 0.1) : 0)} KB`;
  }
  return `${formatAmount(bytes / MIB)} MB`;
}

/** "10 MB": the server's inclusive limit of 10,485,760 bytes. */
export const MAX_FILE_SIZE_LABEL = formatFileSize(MAX_FILE_BYTES);

export const UNSUPPORTED_TYPE_MESSAGE =
  "This file type isn't supported. Choose a JPEG, PNG or WebP photo.";
export const FILE_TOO_LARGE_MESSAGE = `This photo is larger than ${MAX_FILE_SIZE_LABEL}. Choose a photo of ${MAX_FILE_SIZE_LABEL} or less.`;
export const EMPTY_FILE_MESSAGE = "This file is empty. Choose another photo.";
export const MULTIPLE_FILES_MESSAGE = "Please choose one photo at a time.";
export const UNREADABLE_IMAGE_MESSAGE =
  "This photo couldn't be read. It may be damaged. Choose another photo.";
export const GENERIC_UPLOAD_ERROR_MESSAGE = "The photo couldn't be uploaded. Please try again.";
export const UPLOAD_PROGRESS_MESSAGE = "Uploading your photo…";
export const UPLOAD_SUCCESS_MESSAGE = "Your photo was uploaded.";

/** The parts of a `File` that the browser checks look at. */
export interface PhotoCandidate {
  readonly type: string;
  readonly size: number;
}

/**
 * Checks one file's browser-reported type and its size. Returns the message
 * to show, or `null` when the file may be sent.
 */
export function checkFile(file: PhotoCandidate): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return UNSUPPORTED_TYPE_MESSAGE;
  }
  if (file.size === 0) return EMPTY_FILE_MESSAGE;
  if (file.size > MAX_FILE_BYTES) return FILE_TOO_LARGE_MESSAGE;
  return null;
}

export type FileSelection<T extends PhotoCandidate> =
  /** No file at all, such as dropped text or a link: change nothing. */
  | { readonly kind: "none" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "accepted"; readonly file: T };

/** Checks the files from a picker `change` or a drop (`FileList` or array). */
export function checkFiles<T extends PhotoCandidate>(files: ArrayLike<T>): FileSelection<T> {
  if (files.length === 0) return { kind: "none" };
  if (files.length > 1) return { kind: "rejected", message: MULTIPLE_FILES_MESSAGE };
  const file = files[0];
  const message = checkFile(file);
  return message === null ? { kind: "accepted", file } : { kind: "rejected", message };
}

/**
 * The request body: exactly one multipart field, `image`. Any other field
 * makes the server answer 400 INVALID_UPLOAD.
 */
export function buildUploadBody(file: Blob): FormData {
  const body = new FormData();
  body.append("image", file);
  return body;
}

export type UploadResult =
  | { readonly ok: true; readonly uploadId: string }
  | { readonly ok: false; readonly message: string };

const genericFailure: UploadResult = { ok: false, message: GENERIC_UPLOAD_ERROR_MESSAGE };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Turns the server's answer into what the page shows. Only HTTP 201 with an
 * `upload.id` is a success, and only the documented JSON error shape supplies
 * a message; anything else gets the generic message, never a status code or
 * raw response text. The upload id is a private capability: callers must not
 * show, log or store it.
 */
export async function readUploadResponse(response: Response): Promise<UploadResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return genericFailure;
  }

  if (response.status === 201) {
    const id = isRecord(body) && isRecord(body.upload) ? body.upload.id : undefined;
    return typeof id === "string" && id.length > 0 ? { ok: true, uploadId: id } : genericFailure;
  }

  if (!response.ok && isRecord(body) && isRecord(body.error)) {
    const { code, message } = body.error;
    if (typeof code === "string" && typeof message === "string" && message.trim() !== "") {
      return { ok: false, message };
    }
  }
  return genericFailure;
}

export interface UploadOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * Sends one `POST /api/upload`. The `Content-Type` header is left to `fetch`,
 * which adds the multipart boundary. Never throws: a network failure, an
 * abort or an unexpected answer becomes the generic message.
 */
export async function uploadPhoto(file: Blob, options: UploadOptions = {}): Promise<UploadResult> {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await send(UPLOAD_ENDPOINT, {
      method: "POST",
      body: buildUploadBody(file),
      signal: options.signal,
    });
  } catch {
    return genericFailure;
  }
  return readUploadResponse(response);
}
