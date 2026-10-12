/** Fixed, secret-free limits shared by upload validation and documentation. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const UPLOAD_TTL_MS = 10 * 60 * 1000;
export const MAX_RETAINED_BYTES = 100 * 1024 * 1024;
export const MAX_RETAINED_UPLOADS = 100;
