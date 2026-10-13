import type { CSSProperties } from "react";
import type { MoodResult } from "../../lib/mood";
import type { PaletteResult } from "../../lib/palette";
import { confidenceWords, textColorForBackground } from "./theme";
import styles from "./mood-view.module.css";

export interface MoodViewProps {
  readonly mood: MoodResult;
  readonly palette: PaletteResult;
  readonly photo: { readonly src: string; readonly alt: string };
}

export function MoodView({ mood, palette, photo }: MoodViewProps) {
  const background = palette.colors[0];
  const pageStyle = {
    backgroundColor: background,
    color: textColorForBackground(background),
  } satisfies CSSProperties;
  return (
    <article className={styles.result} style={pageStyle}>
      <header className={styles.moodHeader}>
        <div className={styles.headingGroup}>
          <p className={styles.eyebrow}>A possible reading of this photo</p>
          <h1>{mood.primaryEmotion}</h1>
        </div>
      </header>

      {mood.secondaryMoods.length > 0 && (
        <ul className={styles.tags} aria-label="Secondary moods">
          {mood.secondaryMoods.map((tag, index) => {
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

      <p className={styles.explanation}>{mood.explanation}</p>
      <p className={styles.confidence}>
        How sure this reading feels: <strong>{confidenceWords(mood.confidence)}</strong>
      </p>

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

