import { describe, expect, it, vi } from "vitest";
import { copyText } from "./copy";

describe("copyText", () => {
  it("writes text to the clipboard when permitted", async () => {
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const select = vi.fn();
    expect(await copyText("copy me", clipboard, select)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("copy me");
    expect(select).not.toHaveBeenCalled();
  });

  it("selects text and returns the manual-copy state when clipboard is missing or denied", async () => {
    const select = vi.fn();
    expect(await copyText("copy me", undefined, select)).toBe(false);
    expect(select).toHaveBeenCalledOnce();
    const denied = { writeText: vi.fn(async () => { throw new Error("denied"); }) };
    expect(await copyText("copy me", denied, select)).toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
