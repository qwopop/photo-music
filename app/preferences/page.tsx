import { parsePreferences } from "@/lib/preferences";
import { PreferencesForm } from "./preferences-form";

export const metadata = { title: "Your music taste" };

export default async function PreferencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  return (
    <main style={{ width: "min(100% - 2rem, 40rem)", margin: "2rem auto" }}>
      <h1>Your music taste</h1>
      <PreferencesForm initial={parsePreferences(params)} />
    </main>
  );
}
