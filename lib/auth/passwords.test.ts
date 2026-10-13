import { describe, expect, it } from "vitest";
import { getDummyHash, hashPassword, verifyPassword } from "./passwords";

describe("argon2id passwords", () => {
  it("uses the required algorithm/settings and independent salts", async () => {
    const [a, b] = await Promise.all([hashPassword("12345678"), hashPassword("12345678")]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(b).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("12345678");
    expect(await verifyPassword(a, "12345678")).toBe(true);
    expect(await verifyPassword(a, "87654321")).toBe(false);
  });
  it("normalizes before hashing and verification", async () => {
    const hash = await hashPassword("cafécafé");
    expect(await verifyPassword(hash, "cafe\u0301cafe\u0301")).toBe(true);
  });
  it("preserves spaces", async () => {
    const hash = await hashPassword(" 12345678 ");
    expect(await verifyPassword(hash, " 12345678 ")).toBe(true);
    expect(await verifyPassword(hash, "12345678")).toBe(false);
  });
  it.each(["", "broken", "$argon2id$bad", "$argon2id$v=19$m=19456,t=2,p=1$bad$bad"])("returns false for an unparseable stored hash %j", async (value) => {
    expect(await verifyPassword(value, "12345678")).toBe(false);
  });
  it("lazily reuses a fixed dummy hash with the same settings", async () => {
    expect(getDummyHash()).toBe(getDummyHash());
    expect(await getDummyHash()).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
});
