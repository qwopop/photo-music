import Link from "next/link";
import { redirect } from "next/navigation";
import { loadHistory } from "@/lib/history/history";
import { DeleteButton } from "./delete-button";

export const metadata = { title: "Your history" };

export default async function HistoryPage() {
  const history = await loadHistory();
  if (history.status === "unauthorized") redirect("/login");
  return (
    <main style={{ width: "min(100% - 2rem, 48rem)", margin: "2rem auto" }}>
      <h1>Your history</h1>
      {history.items.length === 0 ? (
        <p>
          You have no saved results yet. <Link href="/">Upload a photo</Link> to get started.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "1rem" }}>
          {history.items.map((item) => (
            <li key={item.id} style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
              {item.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a private photo
                <img src={item.photoUrl} alt="" width={96} height={96} style={{ objectFit: "cover" }} />
              ) : (
                <div role="img" aria-label="Photo unavailable" style={{ width: 96, height: 96, display: "grid", placeItems: "center", border: "1px solid #8886" }}>
                  No photo
                </div>
              )}
              <Link href={`/history/${item.id}`}>
                {item.label}
                <br />
                <time dateTime={item.createdAt.toISOString()}>{item.createdAt.toISOString().slice(0, 10)}</time>
              </Link>
              <DeleteButton id={item.id} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
