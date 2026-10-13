"use server";

import { saveResult, type SaveOutcome } from "@/lib/save/save-result";

/** Server action for the Save button. The user is read from the session, never from the arguments. */
export async function saveResultAction(input: Parameters<typeof saveResult>[0]): Promise<SaveOutcome> {
  try {
    return await saveResult(input);
  } catch {
    return { status: "error", code: "failed", message: "Saving failed. Please try again." };
  }
}
