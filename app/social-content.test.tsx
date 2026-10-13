import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { SocialContent } from "../lib/social";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState<T>(initial: T) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) hooks.states[index] = initial;
      return [
        hooks.states[index] as T,
        (value: T | ((previous: T) => T)) => {
          hooks.states[index] = typeof value === "function"
            ? (value as (previous: T) => T)(hooks.states[index] as T)
            : value;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      return { current: initial };
    },
  };
});

import { SocialContentSection } from "./social-content";

type TestElement = ReactElement<{
  children?: ReactNode;
  ref?: (node: HTMLElement | null) => void;
  onClick?: () => void;
}>;

const content: SocialContent = {
  captions: [
    { tone: "casual", text: "A quiet evening." },
    { tone: "poetic", text: "The last light rests." },
    { tone: "funny", text: "My camera needed a minute." },
  ],
  hashtags: ["#evening", "#calm", "#music", "#sunset", "#photo"],
  storyText: "Taking the slow way home.",
};

function allElements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!isValidElement(node)) return [];
  const element = node as TestElement;
  return [element, ...allElements(element.props.children)];
}

function rendered() {
  hooks.cursor = 0;
  return allElements(SocialContentSection({ content }));
}

function buttonWithText(label: string): TestElement {
  const button = rendered().find((element) =>
    element.type === "button" && element.props.children === label
  );
  if (!button) throw new Error(`Could not find button: ${label}`);
  return button;
}

describe("SocialContentSection clipboard behavior", () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.cursor = 0;
    vi.unstubAllGlobals();
  });

  it("copies a caption and briefly renders the copied confirmation", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { setTimeout: vi.fn() });

    await buttonWithText("Copy").props.onClick?.();

    expect(writeText).toHaveBeenCalledWith(content.captions[0].text);
    expect(buttonWithText("Copied").props.children).toBe("Copied");
  });

  it.each(["denied", "unavailable"] as const)("selects the text and shows manual-copy guidance when clipboard is %s", async (mode) => {
    const writeText = vi.fn(async () => {
      if (mode === "denied") throw new Error("clipboard denied");
    });
    vi.stubGlobal("navigator", mode === "unavailable" ? {} : { clipboard: { writeText } });
    const range = { selectNodeContents: vi.fn() };
    const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
    vi.stubGlobal("document", { createRange: () => range });
    vi.stubGlobal("window", { getSelection: () => selection });

    const elements = rendered();
    const paragraph = elements.find((element) =>
      element.type === "p" && element.props.children === content.captions[0].text
    );
    if (!paragraph) throw new Error("Could not find caption text");
    paragraph.props.ref?.({} as HTMLElement);
    const copyButton = elements.find((element) => element.type === "button" && element.props.children === "Copy");
    if (!copyButton) throw new Error("Could not find copy button");
    await copyButton.props.onClick?.();

    expect(range.selectNodeContents).toHaveBeenCalledOnce();
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledWith(range);
    expect(rendered().some((element) =>
      element.props.children === "Press Ctrl/Cmd+C to copy the selected text."
    )).toBe(true);
  });
});
