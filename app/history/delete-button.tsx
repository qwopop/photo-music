"use client";

import { useState } from "react";
import { deleteSavedResultAction } from "./actions";

export function DeleteButton({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function remove() {
    if (!window.confirm("Delete this photo and its playlist? This cannot be undone.")) return;
    setPending(true);
    setMessage("");
    try {
      const result = await deleteSavedResultAction(id);
      if (!result.ok) setMessage("Deletion failed. Please try again.");
      else if (!result.deleted) setMessage("This saved result was not found.");
      else setMessage(result.storageCleanupPending ? "Result deleted; photo cleanup is pending." : "Result deleted.");
    } catch {
      setMessage("Deletion failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={pending} onClick={remove}>{pending ? "Deleting…" : "Delete"}</button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
