import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadHistoryItem, moodLabel } from "@/lib/history/history";
import { DeleteButton } from "../delete-button";

export const metadata = { title: "Saved result" };

export default async function HistoryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await loadHistoryItem(id);
  if (detail.status === "unauthorized") redirect("/login");
  // Unknown id and another user's id are the same not-found page.
  if (detail.status === "not-found") notFound();
  const { result, photoUrl } = detail;
  return (
    <main style={{ width: "min(100% - 2rem, 48rem)", margin: "2rem auto" }}>
      <p>
        <Link href="/history">Back to history</Link>
      </p>
      <h1>{moodLabel(result.mood.primaryEmotion)}</h1>
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a private photo
        <img src={photoUrl} alt="Your saved photo" style={{ maxWidth: "100%", height: "auto" }} />
      ) : (
        <p role="img" aria-label="Photo unavailable">The photo is unavailable right now.</p>
      )}
      <p>
        <time dateTime={result.createdAt.toISOString()}>{result.createdAt.toISOString().slice(0, 10)}</time>
      </p>
      <p>{result.mood.explanation}</p>
      {result.mood.secondaryMoods.length > 0 && <p>Also: {result.mood.secondaryMoods.join(", ")}</p>}
      <h2>Playlist</h2>
      <ol>
        {result.playlist.tracks.map((track) => (
          <li key={track.spotifyId}>
            <a href={track.spotifyUrl} rel="noreferrer">
              {track.title}
            </a>{" "}
            by {track.artists.join(", ")} (<a href={track.youtube.url} rel="noreferrer">{track.youtube.kind === "video" ? "YouTube" : "Search on YouTube"}</a>)
            {track.spotifyId === result.playlist.featuredTrackId && " - featured"}
            <br />
            <small>{track.matchReason}</small>
          </li>
        ))}
      </ol>
      <DeleteButton id={result.id} redirectTo="/history" />
    </main>
  );
}
