"use client";

import { useRef, useState } from "react";
import type { SocialContent } from "../lib/social";
import { copyText } from "../lib/social/copy";

export function SocialContentSection({
  content,
  loading = false,
  error,
  onRetry,
}: {
  content: SocialContent | null;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState("");
  const [manualCopy, setManualCopy] = useState(false);
  const textRefs = useRef(new Map<string, HTMLElement>());

  async function copy(key: string, text: string) {
    setManualCopy(false);
    const succeeded = await copyText(text, typeof navigator === "undefined" ? undefined : navigator.clipboard, () => {
      const target = textRefs.current.get(key);
      if (!target) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setManualCopy(true);
    });
    if (!succeeded) return;
    setCopied(key);
    window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1500);
  }

  return (
    <section aria-labelledby="social-content-title" aria-busy={loading}>
      <h2 id="social-content-title">Instagram-ready text</h2>
      {loading && <p role="status">Generating captions…</p>}
      {error && <p role="alert">{error}</p>}
      {error && onRetry && <button type="button" onClick={onRetry}>Try again</button>}
      {content && !loading && (
        <>
          {content.captions.map(({ tone, text }, index) => {
            const key = `caption-${index}`;
            return (
              <article key={key}>
                <h3>{tone}</h3>
                <p ref={(element) => { if (element) textRefs.current.set(key, element); else textRefs.current.delete(key); }}>{text}</p>
                <button type="button" onClick={() => copy(key, text)}>{copied === key ? "Copied" : "Copy"}</button>
              </article>
            );
          })}
          <div>
            <h3>Hashtags</h3>
            <p ref={(element) => { if (element) textRefs.current.set("hashtags", element); else textRefs.current.delete("hashtags"); }}>
              {content.hashtags.join(" ")}
            </p>
            <button type="button" onClick={() => copy("hashtags", content.hashtags.join(" "))}>
              {copied === "hashtags" ? "Copied" : "Copy all hashtags"}
            </button>
          </div>
          <div>
            <h3>Story</h3>
            <p ref={(element) => { if (element) textRefs.current.set("story", element); else textRefs.current.delete("story"); }}>{content.storyText}</p>
            <button type="button" onClick={() => copy("story", content.storyText)}>
              {copied === "story" ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      )}
      {manualCopy && <p role="status">Press Ctrl/Cmd+C to copy the selected text.</p>}
    </section>
  );
}
