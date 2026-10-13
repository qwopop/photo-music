"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deletePhotoAction } from "./actions";

export const CONFIRM_TEXT = "Delete this photo and its playlist? This cannot be undone.";

export function DeleteButton({ id, redirectTo }: { id: string; redirectTo?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (busy || !window.confirm(CONFIRM_TEXT)) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await deletePhotoAction(id);
      if (outcome.status === "unauthorized") return router.push("/login");
      if (outcome.status === "error") {
        setError(outcome.message);
        return setBusy(false);
      }
      // Deleted, or already gone: either way the item is no longer there.
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch {
      setError("Deleting failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <span>
      <button type="button" onClick={remove} disabled={busy}>
        {busy ? "Deleting..." : "Delete"}
      </button>
      {error && <span role="alert"> {error}</span>}
    </span>
  );
}
