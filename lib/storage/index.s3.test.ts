import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStorageDeps, deletePhoto, deleteUserPhotos, getSignedPhotoUrl,
  uploadPhoto, type StorageDeps,
} from "./index";

describe("private photo storage against real S3", () => {
  const userId = `s3-test-${randomUUID()}`;
  const bytes = Buffer.from("integration photo bytes");
  let deps: StorageDeps;
  let key: string;

  beforeAll(async () => {
    deps = createStorageDeps();
    key = await uploadPhoto({ userId, body: bytes, contentType: "image/png" }, deps);
  });
  afterAll(async () => {
    if (deps) {
      try { await deleteUserPhotos(userId, deps); }
      finally { deps.client.destroy(); }
    }
  });

  it("reads uploaded bytes through a signed URL", async () => {
    const response = await fetch(await getSignedPhotoUrl(key, {}, deps));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("refuses an unsigned GET", async () => {
    const url = new URL(await getSignedPhotoUrl(key, {}, deps));
    url.search = "";
    const response = await fetch(url);
    expect(response.status).toBe(403);
  });

  it("refuses an expired signed URL", async () => {
    const url = await getSignedPhotoUrl(key, { expiresInSeconds: 1 }, deps);
    // Wait beyond S3's whole-second timestamp precision; do not mock the clock.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const response = await fetch(url);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Request has expired");
  });

  it("deletes an object and tolerates deleting the now-missing key", async () => {
    const disposable = await uploadPhoto({ userId, body: bytes, contentType: "image/png" }, deps);
    const url = await getSignedPhotoUrl(disposable, {}, deps);
    await deletePhoto(disposable, deps);
    expect((await fetch(url)).status).toBe(404);
    await expect(deletePhoto(disposable, deps)).resolves.toBeUndefined();
    await expect(deletePhoto(`users/${userId}/${randomUUID()}.png`, deps)).resolves.toBeUndefined();
  });
});
