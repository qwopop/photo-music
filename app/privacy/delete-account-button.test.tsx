import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  remove: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState<T>(initial: T) {
      const index = harness.cursor++;
      if (!(index in harness.states)) harness.states[index] = initial;
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

vi.mock("./actions", () => ({ deleteAccountAction: harness.remove }));

import { DeleteAccountButton } from "./delete-account-button";

type TestElement = ReactElement<{
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}>;

function allElements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!isValidElement(node)) return [];
  const element = node as TestElement;
  return [element, ...allElements(element.props.children)];
}

function rendered() {
  harness.cursor = 0;
  return allElements(DeleteAccountButton());
}

describe("DeleteAccountButton", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    harness.states = [];
    harness.cursor = 0;
    harness.remove.mockReset();
  });

  it("requires confirmation before invoking account deletion", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const button = rendered().find((element) => element.type === "button");
    if (!button) throw new Error("Delete account button was not rendered");

    await button.props.onClick?.();

    expect(confirm).toHaveBeenCalledWith("Delete my account and all data? This cannot be undone.");
    expect(harness.remove).not.toHaveBeenCalled();
  });
});
