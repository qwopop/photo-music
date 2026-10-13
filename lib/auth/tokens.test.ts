import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createToken, sessionId, SESSION_COOKIE_ATTRIBUTES, SESSION_LIFETIME_MS, validToken } from "./tokens";

describe("session capabilities", () => {
  it("creates unique 32-byte base64url tokens", () => {
    const tokens = Array.from({ length: 1_000 }, createToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url").length).toBe(32);
      expect(validToken(token)).toBe(true);
    }
  });
  it("hashes the UTF-8 cookie value to a lowercase SHA-256 hex id", () => {
    const token = createToken();
    expect(sessionId(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(sessionId(token)).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([undefined, "", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, "é".repeat(43), ` ${"a".repeat(42)}`])("rejects malformed tokens %j", (value) => expect(validToken(value)).toBe(false));
  it("requires all cookie attributes and a fixed 30-day lifetime", () => {
    expect(SESSION_COOKIE_ATTRIBUTES).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(SESSION_LIFETIME_MS).toBe(2_592_000_000);
  });
});
