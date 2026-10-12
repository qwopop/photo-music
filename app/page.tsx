import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1>Photo Music</h1>
      <p>Upload a photo, discover its mood, and get music to match.</p>
    </main>
  );
}
