"use server";

import { saveResult, type SaveResultState } from "../../lib/save/save-result";

export async function saveResultAction(input: unknown): Promise<SaveResultState> {
  return saveResult(input);
}
