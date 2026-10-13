export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  selectText: () => void,
): Promise<boolean> {
  try {
    if (!clipboard) throw new Error("Clipboard unavailable");
    await clipboard.writeText(text);
    return true;
  } catch {
    selectText();
    return false;
  }
}
