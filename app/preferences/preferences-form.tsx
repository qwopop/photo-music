"use client";

import { useState } from "react";
import {
  DEFAULT_PREFERENCES, GENRES, LANGUAGES, MAX_ARTISTS, MAX_ARTIST_LENGTH, PREFERENCE_LENGTHS,
  SITUATIONS, serializePreferences, type Preferences,
} from "@/lib/preferences";
import styles from "./preferences-form.module.css";

const LABELS: Record<string, string> = {
  "hip-hop": "Hip-hop", "r-and-b": "R&B", "lo-fi": "Lo-fi",
  "walking-at-night": "Walking at night",
};
const label = (id: string) => LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function PreferencesForm({
  initial = DEFAULT_PREFERENCES,
  onChange,
}: {
  initial?: Preferences;
  onChange?: (preferences: Preferences) => void;
}) {
  const [prefs, setPrefs] = useState<Preferences>(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  function update(next: Preferences) {
    setPrefs(next);
    const query = serializePreferences(next).toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (query ? `?${query}` : ""));
    onChange?.(next);
  }

  function toggle(field: "genres" | "languages", id: string) {
    const list: string[] = prefs[field];
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    update({ ...prefs, [field]: next } as Preferences);
  }

  function addArtist() {
    const name = draft.trim();
    if (name === "") { setDraft(""); setError(""); return; }
    if (name.length > MAX_ARTIST_LENGTH) return setError(`Artist names can have at most ${MAX_ARTIST_LENGTH} characters.`);
    if (prefs.artists.some((a) => a.toLowerCase() === name.toLowerCase())) return setError("That artist is already added.");
    if (prefs.artists.length >= MAX_ARTISTS) return setError(`You can add at most ${MAX_ARTISTS} artists.`);
    setError("");
    setDraft("");
    update({ ...prefs, artists: [...prefs.artists, name] });
  }

  function reset() {
    setDraft("");
    setError("");
    update({ ...DEFAULT_PREFERENCES });
  }

  return (
    <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend>Genres</legend>
        <div className={styles.options}>
          {GENRES.map((id) => (
            <label key={id}>
              <input type="checkbox" checked={prefs.genres.includes(id)} onChange={() => toggle("genres", id)} /> {label(id)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Favorite artists</legend>
        <div className={styles.row}>
          <input
            type="text"
            aria-label="Artist name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addArtist(); } }}
          />
          <button type="button" onClick={addArtist}>Add artist</button>
        </div>
        <p className={styles.error} role="alert">{error}</p>
        <ul className={styles.tags}>
          {prefs.artists.map((name) => (
            <li key={name.toLowerCase()}>
              <span>{name}</span>
              <button type="button" aria-label={`Remove ${name}`} onClick={() => update({ ...prefs, artists: prefs.artists.filter((a) => a !== name) })}>×</button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Languages</legend>
        <div className={styles.options}>
          {LANGUAGES.map((id) => (
            <label key={id}>
              <input type="checkbox" checked={prefs.languages.includes(id)} onChange={() => toggle("languages", id)} /> {label(id)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Situation (optional)</legend>
        <div className={styles.options}>
          <label>
            <input type="radio" name="situation" checked={prefs.situation === null} onChange={() => update({ ...prefs, situation: null })} /> None
          </label>
          {SITUATIONS.map((id) => (
            <label key={id}>
              <input type="radio" name="situation" checked={prefs.situation === id} onChange={() => update({ ...prefs, situation: id })} /> {label(id)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Playlist length</legend>
        <div className={styles.options}>
          {PREFERENCE_LENGTHS.map((n) => (
            <label key={n}>
              <input type="radio" name="length" checked={prefs.length === n} onChange={() => update({ ...prefs, length: n })} /> {n} songs
            </label>
          ))}
        </div>
      </fieldset>

      <div><button type="button" onClick={reset}>Reset</button></div>

      <section aria-labelledby="current-preferences">
        <h2 id="current-preferences">Current preferences</h2>
        <pre className={styles.json}>{JSON.stringify(prefs, null, 2)}</pre>
      </section>
    </form>
  );
}
