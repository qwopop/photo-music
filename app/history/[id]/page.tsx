import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { loadSavedResult } from "../../../lib/history/history";
import { DeleteButton } from "../delete-button";

export default async function SavedResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const saved = await loadSavedResult(id);
  if (saved.kind === "guest") redirect("/login");
  if (saved.kind === "not-found") notFound();
  if (saved.kind !== "ready") return <main><h1>Saved result unavailable</h1><Link href="/history">Back to history</Link></main>;
  const { result, imageUrl } = saved;

  return (
    <main>
      <Link href="/history">Back to history</Link>
      <h1>Looks {result.mood.primaryEmotion}</h1>
      {imageUrl ? <Image src={imageUrl} alt="Saved photo" width={640} height={480} unoptimized /> : <p>Photo preview unavailable.</p>}
      {result.moodCorrected && <p>Mood corrected by you</p>}
      <p>{result.mood.explanation}</p>
      <h2>Playlist</h2>
      <ol>
        {result.playlist.tracks.map((track) => (
          <li key={track.spotifyId}>
            <a href={track.spotifyUrl} rel="noreferrer">{track.title} — {track.artists.join(", ")}</a>
            <p>{track.matchReason}</p>
            {track.youtube.kind === "video"
              ? <a href={track.youtube.url} rel="noreferrer">Watch on YouTube</a>
              : <a href={track.youtube.url} rel="noreferrer">Search YouTube</a>}
          </li>
        ))}
      </ol>
      <DeleteButton id={result.id} />
    </main>
  );
}
