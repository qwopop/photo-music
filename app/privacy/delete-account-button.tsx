"use client";

import { useState } from "react";
import { deleteAccountAction } from "./actions";

export function DeleteAccountButton() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function remove() {
    if (!window.confirm("Delete my account and all data? This cannot be undone.")) return;
    setPending(true);
    setMessage("");
    try {
      const result = await deleteAccountAction();
      if (!result.ok) setMessage(result.message);
    } catch {
      setMessage("Account deletion failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={pending} onClick={remove}>{pending ? "Deleting…" : "Delete my account and all data"}</button>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
