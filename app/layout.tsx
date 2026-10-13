import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Header } from "./auth/header";

export const metadata: Metadata = {
  title: "Photo Music",
  description:
    "Upload a photo, discover its mood, and get a song, a playlist, and Instagram captions to match.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body><Header />{children}</body>
    </html>
  );
}
