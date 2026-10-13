import { describe, expect, it } from "vitest";
import { DELETE, GET, OPTIONS, PATCH, PUT } from "./route";

describe("non-POST /api/analyze methods", () => {
  it.each([
    ["GET", GET],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
    ["OPTIONS", OPTIONS],
  ])("%s returns an uncacheable 405 allowing only POST", async (_method, handler) => {
    const response = handler();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
