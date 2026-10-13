"use client";

import Link from "next/link";
import { useState } from "react";
import { saveResultAction } from "./actions";

type Payload = Omit<Parameters<typeof saveResultAction>[0], "saveId">;

/**
 * `signedIn` must be computed on the server from `getCurrentUser()`. Hiding the
 * button is not the access check: the action checks the user again.
 */
export function SaveButton({ signedIn, payload }: { signedIn: boolean; payload: Payload }) {
  // One id per result view; kept across retries so saving never duplicates.
  const [saveId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  if (!signedIn) return <Link href="/login">Sign in to save</Link>;
  if (state === "saved") {
    return (
      <p role="status">
        Saved to your history. <Link href="/history">View your history</Link>
      </p>
    );
  }

  async function save() {
    if (state === "saving") return;
    setState("saving");
    setError("");
    try {
      const outcome = await saveResultAction({ ...payload, saveId });
      if (outcome.status === "saved") return setState("saved");
      setError(outcome.message);
    } catch {
      setError("Saving failed. Please check your connection and try again.");
    }
    setState("idle");
  }

  return (
    <div>
      <button type="button" onClick={save} disabled={state === "saving"}>
        {state === "saving" ? "Saving..." : "Save to history"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
