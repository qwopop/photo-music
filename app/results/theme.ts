function channels(color: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Expected a six-digit hex color.");
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number];
}

function linearChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const [red, green, blue] = channels(color).map(linearChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function textColorForBackground(background: string): "#000000" | "#ffffff" {
  return contrastRatio("#000000", background) >= contrastRatio("#ffffff", background)
    ? "#000000"
    : "#ffffff";
}

export function confidenceWords(confidence: number): string {
  if (confidence < 0.4) return "Not very sure";
  if (confidence < 0.7) return "Somewhat sure";
  if (confidence < 0.9) return "Fairly sure";
  return "Very sure";
}
