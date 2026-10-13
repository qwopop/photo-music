"use server";

import { revalidatePath } from "next/cache";
import { deleteHistoryItem, type DeleteOutcome } from "@/lib/history/history";

/** Server action for the Delete button. The user is read from the session, never from the arguments. */
export async function deletePhotoAction(id: string): Promise<DeleteOutcome> {
  const outcome = await deleteHistoryItem(typeof id === "string" ? id : "");
  if (outcome.status === "deleted" || outcome.status === "not-found") revalidatePath("/history");
  return outcome;
}
