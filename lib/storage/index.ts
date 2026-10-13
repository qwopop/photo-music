/**
 * Private photo storage in an S3-compatible bucket (AWS S3, R2, MinIO).
 * Server-only.
 *
 * Key layout: `users/<userId>/<uuid>.<jpg|png|webp>`. Objects are always
 * private: this module never sets an ACL and only hands out short-lived
 * presigned GET URLs.
 *
 * Importing this module reads no environment variable and builds no client.
 * Every function builds its client from `getStorageConfig()` when called (so
 * call them only while handling a request), unless a `client` and `bucket`
 * are injected through the last argument, as tests do.
 *
 * Errors never contain the access key, the secret key or a signed URL.
 */
import "server-only";

import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getStorageConfig } from "../config";

export const DEFAULT_URL_LIFETIME_SECONDS = 300;
export const MAX_URL_LIFETIME_SECONDS = 3600;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type StorageErrorCode =
  | "invalid-input"
  | "invalid-key"
  | "invalid-expiry"
  | "s3-error";

/** The only error type this module throws. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Injectable dependencies. Give both, or neither. */
export interface StorageDeps {
  client: S3Client;
  bucket: string;
}

/** Builds the client from config; credentials are passed explicitly. */
export function createStorageDeps(): StorageDeps {
  const config = getStorageConfig();
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint
      ? { endpoint: config.endpoint, forcePathStyle: true }
      : {}),
  });
  return { client, bucket: config.bucket };
}

function resolve(deps?: StorageDeps): StorageDeps {
  return deps ?? createStorageDeps();
}

function validateUserId(userId: string): void {
  if (
    typeof userId !== "string" ||
    userId === "" ||
    userId.includes("/") ||
    userId.includes("\\") ||
    userId.includes("..")
  ) {
    throw new StorageError("invalid-input", "Invalid user id.");
  }
}

function validateKey(key: string): void {
  if (
    typeof key !== "string" ||
    key === "" ||
    !key.startsWith("users/") ||
    key.includes("..")
  ) {
    throw new StorageError("invalid-key", "Invalid storage key.");
  }
}

/** Only the error's name, never its message, which may hold secrets. */
function s3Error(action: string, error: unknown): StorageError {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "Error";
  return new StorageError("s3-error", `Storage ${action} failed (${name}).`);
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.Code === "NoSuchKey" ||
    e.$metadata?.httpStatusCode === 404
  );
}

export async function uploadPhoto(
  input: { userId: string; body: Uint8Array; contentType: string },
  deps?: StorageDeps,
): Promise<string> {
  validateUserId(input.userId);
  const ext = Object.hasOwn(EXTENSIONS, input.contentType)
    ? EXTENSIONS[input.contentType]
    : undefined;
  if (!ext) {
    throw new StorageError("invalid-input", "Unsupported content type.");
  }
  if (!input.body || input.body.byteLength === 0) {
    throw new StorageError("invalid-input", "Empty photo.");
  }
  const key = `users/${input.userId}/${randomUUID()}.${ext}`;
  const { client, bucket } = resolve(deps);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  } catch (error) {
    throw s3Error("upload", error);
  }
  return key;
}

export async function getSignedPhotoUrl(
  key: string,
  options: { expiresInSeconds?: number } = {},
  deps?: StorageDeps,
): Promise<string> {
  validateKey(key);
  const expiresIn = options.expiresInSeconds ?? DEFAULT_URL_LIFETIME_SECONDS;
  if (
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_URL_LIFETIME_SECONDS
  ) {
    throw new StorageError(
      "invalid-expiry",
      `Lifetime must be an integer from 1 to ${MAX_URL_LIFETIME_SECONDS} seconds.`,
    );
  }
  const { client, bucket } = resolve(deps);
  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn },
    );
  } catch (error) {
    throw s3Error("sign", error);
  }
}

export async function deletePhoto(
  key: string,
  deps?: StorageDeps,
): Promise<void> {
  validateKey(key);
  const { client, bucket } = resolve(deps);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isNotFound(error)) return;
    throw s3Error("delete", error);
  }
}

/** Deletes every object under `users/<userId>/`; returns how many. */
export async function deleteUserPhotos(
  userId: string,
  deps?: StorageDeps,
): Promise<number> {
  validateUserId(userId);
  const prefix = `users/${userId}/`;
  const { client, bucket } = resolve(deps);
  let deleted = 0;
  try {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => !!k && k.startsWith(prefix));
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (result?.Errors && result.Errors.length > 0) {
          throw new StorageError("s3-error", "Storage delete failed.");
        }
        deleted += batch.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw s3Error("delete", error);
  }
  return deleted;
}
