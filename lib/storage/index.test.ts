import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageError,
  createStorageDeps,
  deletePhoto,
  deleteUserPhotos,
  getSignedPhotoUrl,
  uploadPhoto,
  type StorageDeps,
} from "./index";

const ACCESS = "AKIAEXAMPLEACCESS123";
const SECRET = "secretSECRETsecret0123456789abcdefghijkl";

function fake(handler: (cmd: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  });
  client.send = vi.fn(async (cmd: unknown) => {
    sent.push(cmd);
    return handler(cmd);
  }) as unknown as typeof client.send;
  const deps: StorageDeps = { client, bucket: "my-bucket" };
  return { deps, sent };
}

const jpeg = new Uint8Array([1, 2, 3]);

afterEach(() => vi.unstubAllEnvs());

describe("import", () => {
  it("reads no config at import time", async () => {
    for (const k of [
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      vi.stubEnv(k, "");
    }
    vi.resetModules();
    await expect(import("./index")).resolves.toBeDefined();
  });
});

describe("createStorageDeps", () => {
  const set = (endpoint: string) => {
    vi.stubEnv("S3_REGION", "eu-central-1");
    vi.stubEnv("S3_BUCKET", "b");
    vi.stubEnv("S3_ACCESS_KEY_ID", ACCESS);
    vi.stubEnv("S3_SECRET_ACCESS_KEY", SECRET);
    vi.stubEnv("S3_ENDPOINT", endpoint);
  };
  it("uses path-style and the endpoint when set", async () => {
    set("http://localhost:9000");
    const { client, bucket } = createStorageDeps();
    expect(bucket).toBe("b");
    expect(client.config.forcePathStyle).toBe(true);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("localhost");
    expect((await client.config.credentials()).accessKeyId).toBe(ACCESS);
  });
  it("uses AWS defaults when no endpoint", () => {
    set("");
    const { client } = createStorageDeps();
    expect(client.config.forcePathStyle).toBeFalsy();
    expect(client.config.endpoint).toBeUndefined();
  });
});

describe("uploadPhoto", () => {
  it("writes under users/<id>/<uuid>.<ext> with no ACL", async () => {
    const { deps, sent } = fake();
    const key = await uploadPhoto(
      { userId: "u1", body: jpeg, contentType: "image/png" },
      deps,
    );
    expect(key).toMatch(/^users\/u1\/[0-9a-f-]{36}\.png$/);
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.Key).toBe(key);
    expect(cmd.input.Bucket).toBe("my-bucket");
    expect(cmd.input.ContentType).toBe("image/png");
    expect(cmd.input).not.toHaveProperty("ACL");
  });

  it.each([
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ])("maps %s to .%s", async (contentType, ext) => {
    const { deps } = fake();
    const key = await uploadPhoto({ userId: "u", body: jpeg, contentType }, deps);
    expect(key.endsWith(`.${ext}`)).toBe(true);
  });

  it("gives different keys for the same bytes", async () => {
    const { deps } = fake();
    const input = { userId: "u", body: jpeg, contentType: "image/jpeg" };
    expect(await uploadPhoto(input, deps)).not.toBe(
      await uploadPhoto(input, deps),
    );
  });

  it.each([
    ["gif", { contentType: "image/gif" }],
    ["inherited property name", { contentType: "constructor" }],
    ["empty body", { body: new Uint8Array() }],
    ["empty user", { userId: "" }],
    ["slash user", { userId: "a/b" }],
    ["dotdot user", { userId: ".." }],
    ["embedded dotdot", { userId: "a..b" }],
  ])("rejects %s without sending", async (_name, override) => {
    const { deps, sent } = fake();
    const input = {
      userId: "u",
      body: jpeg,
      contentType: "image/jpeg",
      ...override,
    };
    await expect(uploadPhoto(input, deps)).rejects.toBeInstanceOf(StorageError);
    expect(sent).toHaveLength(0);
  });

  it("wraps S3 errors without leaking secrets", async () => {
    const { deps } = fake(() => {
      throw Object.assign(new Error(`bad ${ACCESS} ${SECRET}`), {
        name: "AccessDenied",
      });
    });
    const err = await uploadPhoto(
      { userId: "u", body: jpeg, contentType: "image/jpeg" },
      deps,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as Error).message).not.toContain(ACCESS);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("getSignedPhotoUrl", () => {
  const key = "users/u1/abc.jpg";
  it("returns a presigned URL with the default 300s lifetime", async () => {
    const { deps } = fake();
    const url = new URL(await getSignedPhotoUrl(key, {}, deps));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.hostname + url.pathname).toContain("my-bucket");
    expect(decodeURIComponent(url.pathname)).toContain(key);
  });
  it("accepts a lifetime of 3600", async () => {
    const { deps } = fake();
    const url = new URL(
      await getSignedPhotoUrl(key, { expiresInSeconds: 3600 }, deps),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });
  it.each([0, -1, 1.5, 3601, NaN])("rejects lifetime %s", async (n) => {
    const { deps } = fake();
    await expect(
      getSignedPhotoUrl(key, { expiresInSeconds: n }, deps),
    ).rejects.toMatchObject({ code: "invalid-expiry" });
  });
  it.each(["", "photos/x.jpg", "users/../x.jpg", "users/a/..b"])(
    "rejects key %j",
    async (k) => {
      const { deps } = fake();
      await expect(getSignedPhotoUrl(k, {}, deps)).rejects.toMatchObject({
        code: "invalid-key",
      });
    },
  );
});

describe("deletePhoto", () => {
  const key = "users/u1/abc.jpg";
  it("deletes exactly that key", async () => {
    const { deps, sent } = fake();
    await deletePhoto(key, deps);
    const cmd = sent[0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: "my-bucket", Key: key });
  });
  it("validates the key", async () => {
    const { deps, sent } = fake();
    await expect(deletePhoto("x/../y", deps)).rejects.toBeInstanceOf(
      StorageError,
    );
    expect(sent).toHaveLength(0);
  });
  it("treats not found as success", async () => {
    const { deps } = fake(() => {
      throw Object.assign(new Error("nf"), { name: "NoSuchKey" });
    });
    await expect(deletePhoto(key, deps)).resolves.toBeUndefined();
  });
  it("throws a clean StorageError on other errors", async () => {
    const { deps } = fake(() => {
      throw Object.assign(new Error(`denied ${SECRET} ${ACCESS}`), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    });
    const err = (await deletePhoto(key, deps).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(ACCESS);
  });
});

describe("deleteUserPhotos", () => {
  it("paginates, batches by 1000 and stays inside the prefix", async () => {
    const mk = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        Key: `users/12/${from + i}.jpg`,
      }));
    const deletes: string[][] = [];
    const prefixes: (string | undefined)[] = [];
    const { deps } = fake((cmd) => {
      if (cmd instanceof ListObjectsV2Command) {
        prefixes.push(cmd.input.Prefix);
        return cmd.input.ContinuationToken
          ? { Contents: [...mk(1200, 300), { Key: "users/123/x.jpg" }] }
          : {
              Contents: mk(0, 1200),
              IsTruncated: true,
              NextContinuationToken: "t",
            };
      }
      if (cmd instanceof DeleteObjectsCommand) {
        deletes.push((cmd.input.Delete?.Objects ?? []).map((o) => o.Key ?? ""));
        return {};
      }
      return {};
    });
    expect(await deleteUserPhotos("12", deps)).toBe(1500);
    expect(prefixes).toEqual(["users/12/", "users/12/"]);
    expect(deletes.map((d) => d.length)).toEqual([1000, 200, 300]);
    expect(deletes.flat().every((k) => k.startsWith("users/12/"))).toBe(true);
  });
  it("returns 0 for an empty prefix and validates the id", async () => {
    const { deps, sent } = fake();
    expect(await deleteUserPhotos("u", deps)).toBe(0);
    await expect(deleteUserPhotos("a/b", deps)).rejects.toBeInstanceOf(
      StorageError,
    );
    expect(sent).toHaveLength(1);
  });
  it("fails on per-key delete errors", async () => {
    const { deps } = fake((cmd) =>
      cmd instanceof ListObjectsV2Command
        ? { Contents: [{ Key: "users/u/a.jpg" }] }
        : { Errors: [{ Key: "users/u/a.jpg", Code: "AccessDenied" }] },
    );
    await expect(deleteUserPhotos("u", deps)).rejects.toBeInstanceOf(
      StorageError,
    );
  });
});
