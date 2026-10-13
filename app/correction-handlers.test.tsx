import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOOD_EXAMPLES, moodResultSchema, type MoodCorrectionState, type MoodResult } from "../lib/mood";
import { MoodView } from "./results/mood-view";
import { DemoMoodView } from "./results/demo/demo-mood-view";
import { analyzePhotoMood } from "../lib/vision";

const hooks = vi.hoisted(() => ({ correction: undefined as unknown, requested: null as unknown }));
vi.mock("../lib/vision", () => ({ analyzePhotoMood: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown, initialize: (value: unknown) => unknown) => {
      hooks.correction ??= initialize(initial);
      return [hooks.correction, (action: unknown) => { hooks.correction = reducer(hooks.correction, action); }];
    },
    useState: () => [hooks.requested, (value: unknown) => { hooks.requested = value; }],
  };
});

type Props = { children?: ReactNode; onClick?: () => void; onChange?: () => void; value?: string; disabled?: boolean; checked?: boolean; role?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Props>(node) ? text(node.props.children) : "";
}
const props = (mood: MoodResult) => ({ mood, palette: { colors: Array(6).fill("#777777"), brightness: 0.5 }, photo: { src: "/synthetic.svg", alt: "Synthetic analysed photo" } });
function view(mood: MoodResult = MOOD_EXAMPLES[0], onRegenerate = vi.fn()) {
  return MoodView({ ...props(mood), onRegenerate });
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find((element) => element.type === "button" && text(element.props.children) === label);
  expect(found, label).toBeDefined();
  return found!;
}
function input(tree: ReactNode, value: string) {
  const found = elements(tree).find((element) => element.type === "input" && element.props.value === value);
  expect(found, value).toBeDefined();
  return found!;
}
const state = () => hooks.correction as MoodCorrectionState;

beforeEach(() => { hooks.correction = undefined; hooks.requested = null; vi.clearAllMocks(); });

describe("actual mood view handlers", () => {
  it("selects primary and secondary moods, blocks a fourth, applies and resets without vision", () => {
    const regenerate = vi.fn();
    const render = () => view(MOOD_EXAMPLES[0], regenerate);
    button(render(), "Correct the mood").props.onClick!();
    expect(button(render(), "Apply").props.disabled).toBe(true);
    input(render(), "calm").props.onChange!();
    for (const tag of [...state().draftSecondaryMoods]) input(render(), tag).props.onChange!();
    for (const tag of ["warm", "peaceful", "dreamy"]) input(render(), tag).props.onChange!();
    const fourth = input(render(), "nostalgic");
    expect(fourth.props.disabled).toBe(true);
    expect(text(render())).toContain("You can choose up to three");
    fourth.props.onChange!();
    expect(state().draftSecondaryMoods).toEqual(["warm", "peaceful", "dreamy"]);
    expect(button(render(), "Apply").props.disabled).toBe(false);
    button(render(), "Apply").props.onClick!();
    expect(text(render())).toContain("Corrected by you");
    const corrected = moodResultSchema.parse(state().currentMood);
    expect(corrected).toEqual({ ...MOOD_EXAMPLES[0], primaryEmotion: "calm", secondaryMoods: ["warm", "peaceful", "dreamy"] });
    button(render(), "Regenerate").props.onClick!();
    expect(regenerate).toHaveBeenCalledWith(corrected);
    button(render(), "Reset to original reading").props.onClick!();
    expect(state().currentMood).toEqual(MOOD_EXAMPLES[0]);
    expect(text(render())).not.toContain("Corrected by you");
    button(render(), "Regenerate").props.onClick!();
    expect(regenerate).toHaveBeenLastCalledWith(MOOD_EXAMPLES[0]);
    expect(analyzePhotoMood).not.toHaveBeenCalled();
  });

  it("keeps an unknown original tag until its actual checkbox removes it and supports cancel", () => {
    const original = { ...MOOD_EXAMPLES[0], secondaryMoods: ["unlisted atmosphere"] };
    const render = () => view(original);
    button(render(), "Correct the mood").props.onClick!();
    expect(input(render(), "unlisted atmosphere").props.checked).toBe(true);
    input(render(), "sad").props.onChange!();
    button(render(), "Apply").props.onClick!();
    expect(state().currentMood.secondaryMoods).toEqual(["unlisted atmosphere"]);
    button(render(), "Correct the mood").props.onClick!();
    input(render(), "unlisted atmosphere").props.onChange!();
    button(render(), "Cancel").props.onClick!();
    expect(state().currentMood.secondaryMoods).toEqual(["unlisted atmosphere"]);
    button(render(), "Correct the mood").props.onClick!();
    input(render(), "unlisted atmosphere").props.onChange!();
    button(render(), "Apply").props.onClick!();
    expect(state().currentMood.secondaryMoods).toEqual([]);
    expect(analyzePhotoMood).not.toHaveBeenCalled();
  });

  it("the mounted demo callback receives the actual corrected mood from Regenerate", () => {
    const demo = () => DemoMoodView(props(MOOD_EXAMPLES[0]));
    const mountedProps = () => elements(demo()).find((element) => element.type === MoodView)!.props as unknown as Parameters<typeof MoodView>[0];
    const render = () => MoodView(mountedProps());
    button(render(), "Correct the mood").props.onClick!();
    input(render(), "romantic").props.onChange!();
    button(render(), "Apply").props.onClick!();
    button(render(), "Regenerate").props.onClick!();
    expect(hooks.requested).toEqual(state().currentMood);
    expect(text(demo())).toContain("Demo: regeneration requested for romantic");
    expect(text(demo())).toContain("Recommendations are not generated in this demo");
    expect(analyzePhotoMood).not.toHaveBeenCalled();
  });
});
