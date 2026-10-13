"use client";

import { useReducer, type CSSProperties } from "react";
import {
  PRIMARY_EMOTIONS,
  SECONDARY_MOOD_OPTIONS,
  createMoodCorrectionState,
  isMoodCorrectionDirty,
  moodCorrectionReducer,
  type MoodResult,
} from "../../lib/mood";
import type { PaletteResult } from "../../lib/palette";
import { confidenceWords, textColorForBackground } from "./theme";
import styles from "./mood-view.module.css";

export interface MoodViewProps {
  readonly mood: MoodResult;
  readonly palette: PaletteResult;
  readonly photo: { readonly src: string; readonly alt: string };
}

function isPrimaryEmotion(value: string): value is (typeof PRIMARY_EMOTIONS)[number] {
  return (PRIMARY_EMOTIONS as readonly string[]).includes(value);
}

export function MoodView({ mood, palette, photo }: MoodViewProps) {
  const [state, dispatch] = useReducer(moodCorrectionReducer, mood, createMoodCorrectionState);
  const background = palette.colors[0];
  const pageStyle = {
    backgroundColor: background,
    color: textColorForBackground(background),
  } satisfies CSSProperties;
  const selectedCount = state.draftSecondaryMoods.length;
  const knownMoods = new Set<string>(SECONDARY_MOOD_OPTIONS);
  const extraMoods = state.draftSecondaryMoods.filter((tag) => !knownMoods.has(tag));

  return (
    <article className={styles.result} style={pageStyle}>
      <header className={styles.moodHeader}>
        <div className={styles.headingGroup}>
          <p className={styles.eyebrow}>A possible reading of this photo</p>
          <h1>{state.currentMood.primaryEmotion}</h1>
        </div>
        <div className={styles.moodActions}>
          {state.corrected && <span className={styles.corrected}>Corrected by you</span>}
          {state.corrected && (
            <button
              type="button"
              className={styles.secondaryButton}
              aria-label="Reset to detected mood"
              onClick={() => dispatch({ type: "reset" })}
            >
              Reset to original reading
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => dispatch({ type: "open" })}
          >
            Correct the mood
          </button>
        </div>
      </header>

      {state.currentMood.secondaryMoods.length > 0 && (
        <ul className={styles.tags} aria-label="Secondary moods">
          {state.currentMood.secondaryMoods.map((tag, index) => {
            const color = palette.colors[(index + 1) % palette.colors.length];
            return (
              <li
                key={`${tag}-${index}`}
                className={styles.tag}
                style={{ backgroundColor: color, color: textColorForBackground(color) }}
              >
                {tag}
              </li>
            );
          })}
        </ul>
      )}

      {state.corrected && <p className={styles.interpretation}>You changed this interpretation.</p>}
      <p className={styles.explanation}>{state.currentMood.explanation}</p>
      <p className={styles.confidence}>
        How sure this reading feels: <strong>{confidenceWords(state.currentMood.confidence)}</strong>
      </p>

      {state.editorOpen && (
        <section className={styles.editor} aria-label="Correct the mood">
          <fieldset className={styles.choiceGroup}>
            <legend>Choose a primary mood</legend>
            {PRIMARY_EMOTIONS.map((emotion) => (
              <label className={styles.choice} key={emotion}>
                <input
                  type="radio"
                  name="primary-emotion"
                  value={emotion}
                  checked={state.draftPrimaryEmotion === emotion}
                  onChange={() => {
                    if (isPrimaryEmotion(emotion)) {
                      dispatch({ type: "choose-primary", emotion });
                    }
                  }}
                />
                {emotion}
              </label>
            ))}
          </fieldset>

          <fieldset className={styles.choiceGroup}>
            <legend>Choose up to three secondary moods</legend>
            <div className={styles.moodChoices}>
              {[...SECONDARY_MOOD_OPTIONS, ...extraMoods].map((tag) => {
                const checked = state.draftSecondaryMoods.includes(tag);
                return (
                  <label className={styles.choice} key={tag}>
                    <input
                      type="checkbox"
                      value={tag}
                      checked={checked}
                      disabled={!checked && selectedCount >= 3}
                      onChange={() => dispatch({ type: "toggle-secondary", mood: tag })}
                    />
                    {tag}
                  </label>
                );
              })}
            </div>
            {selectedCount >= 3 && (
              <p className={styles.limitMessage} role="status">
                You can choose up to three. Remove a selection to add another.
              </p>
            )}
          </fieldset>

          <div className={styles.editorActions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!isMoodCorrectionDirty(state)}
              onClick={() => dispatch({ type: "apply" })}
            >
              Apply
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => dispatch({ type: "cancel" })}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <figure className={styles.photo}>
        {/* The illustration is a local synthetic fixture and is not a user upload. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.src} alt={photo.alt} />
      </figure>

      <section className={styles.palette} aria-label="Photo color palette">
        <h2>Colors in this photo</h2>
        <ul className={styles.swatches}>
          {palette.colors.map((color, index) => (
            <li
              key={`${color}-${index}`}
              className={styles.swatch}
              style={{ backgroundColor: color, color: textColorForBackground(color) }}
            >
              {color}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

