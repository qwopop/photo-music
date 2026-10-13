import { describe, expect, it } from "vitest";
import { clientIpKey, requestClientKey } from "./client-ip";

describe("clientIpKey", () => {
  it("takes the first entry of a list and trims it", () => {
    expect(clientIpKey(" 203.0.113.7 , 10.0.0.1")).toBe("203.0.113.7");
  });
  it.each([undefined, null, "", "  ", "not-an-ip", "999.1.1.1", "1.2.3", "fe80::1%eth0", "1:2:3:4:5:6:7:8:9", "1::2::3"])("returns null for %j", (value) => {
    expect(clientIpKey(value)).toBeNull();
  });
  it("does not fall back to later entries when the first is invalid", () => {
    expect(clientIpKey("garbage, 203.0.113.7")).toBeNull();
  });
  it("reduces IPv6 to the /64 prefix, whatever the notation", () => {
    const key = clientIpKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(clientIpKey("2001:0DB8:0001:0002::1")).toBe(key);
    expect(clientIpKey("2001:db8:1:2::")).toBe(key);
    expect(clientIpKey("2001:db8:1:3::1")).not.toBe(key);
    expect(clientIpKey("::1")).toBe("0:0:0:0::/64");
    expect(clientIpKey("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
  });
});

describe("requestClientKey", () => {
  const headers = new Headers({ "x-forwarded-for": "198.51.100.9", "x-vercel-forwarded-for": "203.0.113.7" });
  it("reads only the configured header", () => {
    expect(requestClientKey(headers, "x-vercel-forwarded-for")).toBe("203.0.113.7");
    expect(requestClientKey(headers, "cf-connecting-ip")).toBeNull();
  });
  it("ignores a spoofed x-forwarded-for when it is not the configured header", () => {
    const spoofed = new Headers({ "x-forwarded-for": "198.51.100.9" });
    expect(requestClientKey(spoofed, "x-vercel-forwarded-for")).toBeNull();
    expect(requestClientKey(headers, "x-vercel-forwarded-for")).not.toBe("198.51.100.9");
  });
});
