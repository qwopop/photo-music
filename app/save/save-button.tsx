"use client";

import Link from "next/link";
import { useState } from "react";
import type { MoodResult } from "../../lib/mood";
import type { Playlist } from "../../lib/playlist";
import type { Preferences } from "../../lib/preferences";
import { saveResultAction } from "./actions";

interface SaveButtonProps {
  signedIn: boolean;
  uploadHandle: string;
  mood: MoodResult;
  moodCorrected: boolean;
  preferences: Preferences;
  playlist: Playlist;
}

export function SaveButton(props: SaveButtonProps) {
  const [saveId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  if (!props.signedIn) {
    return <p><a href="/login">Sign in to save</a></p>;
  }

  async function save() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const result = await saveResultAction({
        uploadHandle: props.uploadHandle,
        saveId,
        mood: props.mood,
        moodCorrected: props.moodCorrected,
        preferences: props.preferences,
        playlist: props.playlist,
      });
      setMessage(result.ok ? "Saved to your history." : result.message);
    } catch {
      setMessage("Saving failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Save result">
      <button type="button" disabled={pending} onClick={save}>
        {pending ? "Saving…" : "Save to history"}
      </button>
      {message && <p role="status">{message.includes("Saved") ? <>{message} <Link href="/history">View history</Link></> : message}</p>}
    </section>
  );
}
