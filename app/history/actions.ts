"use server";

import { revalidatePath } from "next/cache";
import { deleteSavedResult, type DeleteSavedResultState } from "../../lib/history/history";

export async function deleteSavedResultAction(id: string): Promise<DeleteSavedResultState> {
  const result = await deleteSavedResult(id);
  if (result.ok && result.deleted) revalidatePath("/history");
  return result;
}
