import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOOD_EXAMPLES, type MoodResult } from "../../lib/mood";
import { MoodView } from "./mood-view";
import { selectDemoFixture } from "./demo/fixtures";
import { confidenceWords, contrastRatio, textColorForBackground } from "./theme";

const appResults = resolve(process.cwd(), "app/results");

function syntheticPalette(colors: string[]) {
  return { colors, brightness: 0.5 };
}

function markupFor(mood: MoodResult, colors: string[]) {
  return renderToStaticMarkup(
    <MoodView
      mood={mood}
      palette={syntheticPalette(colors)}
      photo={{ src: "/synthetic.svg", alt: "Synthetic illustration shown as the analysed photo" }}
    />,
  );
}

describe("results mood view", () => {
  it.each(MOOD_EXAMPLES)("renders the $primaryEmotion example as an interpretation with six labelled colors", (mood) => {
    const colors = ["#f4c6a8", "#e18b65", "#ffd166", "#8ecae6", "#6d597a", "#f7ede2"];
    const markup = markupFor(mood, colors);
    expect(markup).toContain("A possible reading of this photo");
    expect(markup).toContain(`<h1>${mood.primaryEmotion}</h1>`);
    expect(markup).toContain(mood.explanation);
    expect(markup).toContain('alt="Synthetic illustration shown as the analysed photo"');
    for (const tag of mood.secondaryMoods) expect(markup).toContain(tag);
    for (const color of colors) expect(markup).toContain(color);
    expect(markup).not.toMatch(/\bdetected\b|\bdetermined\b/);
  });

  it("renders zero or three mood tags, a 500-character explanation, a 40-character tag, and all solid swatches", () => {
    const solid = Array(6).fill("#777777");
    const calm: MoodResult = { ...MOOD_EXAMPLES[2], confidence: 0, secondaryMoods: [] };
    const emptyMarkup = markupFor(calm, solid);
    expect(emptyMarkup).not.toContain('aria-label="Secondary moods"');
    const energetic = { ...MOOD_EXAMPLES[3], confidence: 1 };
    const longMood = {
      ...energetic,
      explanation: "A".repeat(500),
      secondaryMoods: ["m".repeat(40), "bold", "lively"],
    } satisfies MoodResult;
    const stressMarkup = markupFor(longMood, solid);
    expect(stressMarkup).toContain(longMood.explanation);
    expect(stressMarkup).toContain("m".repeat(40));
    expect(stressMarkup.match(/<li class="[^"]*swatch[^"]*"/g)).toHaveLength(6);
    expect(emptyMarkup).toContain("Not very sure");
    expect(stressMarkup).toContain("Very sure");
    expect(markupFor({ ...energetic, confidence: 1 }, solid)).toContain("Very sure");
  });

  it("keeps body and accent text at WCAG AA contrast for bright, dark and mid-tone palettes", () => {
    for (const background of ["#ffffff", "#000000", "#777777"]) {
      const foreground = textColorForBackground(background);
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      const accent = background === "#ffffff" ? "#e18b65" : background === "#000000" ? "#f4c6a8" : "#20243a";
      expect(contrastRatio(textColorForBackground(accent), accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    [0, "Not very sure"],
    [0.39, "Not very sure"],
    [0.4, "Somewhat sure"],
    [0.69, "Somewhat sure"],
    [0.7, "Fairly sure"],
    [0.89, "Fairly sure"],
    [0.9, "Very sure"],
    [1, "Very sure"],
  ])("uses the documented confidence band for %s", (confidence, expected) => {
    expect(confidenceWords(confidence)).toBe(expected);
  });

  it("selects known demo fixtures and falls back for unknown query values", () => {
    expect(selectDemoFixture("romantic", "dark", undefined).mood.primaryEmotion).toBe("romantic");
    expect(selectDemoFixture("unexpected", "unexpected", "1").mood.explanation).toHaveLength(500);
    expect(selectDemoFixture("unexpected", "unexpected", undefined).mood.primaryEmotion).toBe("happy");
    expect(selectDemoFixture("sad", "solid", undefined).palette.colors).toEqual(Array(6).fill("#777777"));
    expect(selectDemoFixture("energetic", "bright", "1").mood.secondaryMoods).toEqual(["m".repeat(40)]);
  });

  it("keeps demo source free of account, database, storage, analysis, upload, config and network access", () => {
    const sourceFiles: string[] = [];
    function visit(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) sourceFiles.push(path);
      }
    }
    visit(appResults);
    const forbidden = /(?:lib\/(?:auth|db|storage|vision|analysis|upload|config)|\bfetch\s*\()/;
    for (const path of sourceFiles) expect(readFileSync(path, "utf8")).not.toMatch(forbidden);
  });

});
