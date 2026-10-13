import type { Metadata } from "next";
import demoPhoto from "../fixtures/demo-photo.svg";
import { MoodView } from "../mood-view";
import styles from "./page.module.css";
import { selectDemoFixture } from "./fixtures";

export const metadata: Metadata = {
  title: "Mood reading demo | Photo Music",
  description: "Explore an example photo mood reading and palette.",
};

interface DemoPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function DemoPage({ searchParams }: DemoPageProps) {
  const query = await searchParams;
  const { mood, palette } = selectDemoFixture(
    queryValue(query.mood),
    queryValue(query.palette),
    queryValue(query.stress),
  );

  return (
    <main className={styles.main}>
      <MoodView
        mood={mood}
        palette={palette}
        photo={{
          src: demoPhoto.src,
          alt: "Synthetic illustration shown as the analysed photo",
        }}
      />
    </main>
  );
}
