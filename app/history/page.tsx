import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { loadHistory } from "../../lib/history/history";
import { DeleteButton } from "./delete-button";

export default async function HistoryPage() {
  const history = await loadHistory();
  if (history.kind === "guest") redirect("/login");
  if (history.kind === "unavailable") {
    return <main><h1>Your history</h1><p role="alert">History is temporarily unavailable. Please try again.</p></main>;
  }
  if (history.items.length === 0) {
    return <main><h1>Your history</h1><p>No saved photos yet.</p><Link href="/">Upload a photo</Link></main>;
  }

  return (
    <main>
      <h1>Your history</h1>
      <ul>
        {history.items.map((item) => (
          <li key={item.id}>
            <Link href={`/history/${item.id}`}>
              {item.imageUrl ? <Image src={item.imageUrl} alt="" width={160} height={120} unoptimized /> : <span aria-label="Photo unavailable">No photo preview</span>}
              <span>Looks {item.primaryEmotion}</span>
              <time dateTime={item.createdAt.toISOString()}>{item.createdAt.toLocaleDateString()}</time>
            </Link>
            <DeleteButton id={item.id} />
          </li>
        ))}
      </ul>
      <Link href="/">Upload another photo</Link>
    </main>
  );
}
