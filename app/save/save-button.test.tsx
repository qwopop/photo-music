import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { MOOD_EXAMPLES } from "../../lib/mood";
import { PLAYLIST_EXAMPLES } from "../../lib/playlist";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  save: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState<T>(initial: T) {
      const index = harness.cursor++;
      if (!(index in harness.states)) {
        harness.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return [
        harness.states[index] as T,
        (value: T | ((previous: T) => T)) => {
          harness.states[index] = typeof value === "function"
            ? (value as (previous: T) => T)(harness.states[index] as T)
            : value;
        },
      ] as const;
    },
  };
});

vi.mock("./actions", () => ({ saveResultAction: harness.save }));

import { SaveButton } from "./save-button";

type TestElement = ReactElement<{
  children?: ReactNode;
  disabled?: boolean;
  href?: string;
  onClick?: () => void;
}>;

const props = {
  signedIn: true,
  uploadHandle: "opaque-handle",
  mood: MOOD_EXAMPLES[0],
  moodCorrected: false,
  preferences: PLAYLIST_EXAMPLES[0].preferences,
  playlist: PLAYLIST_EXAMPLES[0],
};

function allElements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!isValidElement(node)) return [];
  const element = node as TestElement;
  return [element, ...allElements(element.props.children)];
}

function hasText(node: ReactNode, text: string): boolean {
  if (typeof node === "string") return node.includes(text);
  if (Array.isArray(node)) return node.some((child) => hasText(child, text));
  return isValidElement(node) && hasText((node.props as { children?: ReactNode }).children, text);
}

function rendered(signedIn = true) {
  harness.cursor = 0;
  return allElements(SaveButton({ ...props, signedIn }));
}

function button() {
  const result = rendered().find((element) => element.type === "button");
  if (!result) throw new Error("Save button was not rendered");
  return result;
}

describe("SaveButton", () => {
  beforeEach(() => {
    harness.states = [];
    harness.cursor = 0;
    harness.save.mockReset();
    vi.stubGlobal("crypto", { randomUUID: () => "828b4289-877e-46a8-9cfb-488c8d1c226b" });
  });

  it("shows guests a sign-in link without a save button", () => {
    const elements = rendered(false);
    expect(elements.some((element) => element.type === "button")).toBe(false);
    expect(elements.some((element) => element.type === "a" && element.props.href === "/login")).toBe(true);
  });

  it("disables during saving, reuses one save id, and confirms with history link", async () => {
    let resolveAction: ((value: { ok: true; id: string; created: boolean }) => void) | undefined;
    harness.save.mockImplementation(() => new Promise((resolve) => { resolveAction = resolve; }));

    button().props.onClick?.();
    expect(harness.save).toHaveBeenCalledWith({
      uploadHandle: props.uploadHandle,
      saveId: "828b4289-877e-46a8-9cfb-488c8d1c226b",
      mood: props.mood,
      moodCorrected: props.moodCorrected,
      preferences: props.preferences,
      playlist: props.playlist,
    });
    expect(button().props.disabled).toBe(true);

    resolveAction?.({ ok: true, id: "saved-result-id", created: true });
    await Promise.resolve();
    await Promise.resolve();
    const elements = rendered();
    expect(elements.some((element) =>
      element.type === "p" && hasText(element.props.children, "Saved to your history")
    )).toBe(true);
    expect(elements.some((element) =>
      element.props.href === "/history"
    )).toBe(true);
    button().props.onClick?.();
    expect(harness.save.mock.calls[1][0]).toMatchObject({ saveId: "828b4289-877e-46a8-9cfb-488c8d1c226b" });
  });
});
