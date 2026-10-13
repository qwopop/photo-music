import Link from "next/link";

export default function HistoryNotFound() {
  return (
    <main style={{ width: "min(100% - 2rem, 40rem)", margin: "2rem auto" }}>
      <h1>Not found</h1>
      <p>This saved result does not exist.</p>
      <Link href="/history">Back to history</Link>
    </main>
  );
}
