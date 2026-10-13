"use client";

import { useState } from "react";
import type { MoodResult } from "../../../lib/mood";
import { MoodView, type MoodViewProps } from "../mood-view";

/** Demonstrates the handoff only; recommendation generation is a later task. */
export function DemoMoodView(props: MoodViewProps) {
  const [requestedMood, setRequestedMood] = useState<MoodResult | null>(null);
  return (
    <>
      <MoodView {...props} onRegenerate={(mood) => setRequestedMood(mood)} />
      <p role="status">
        {requestedMood && `Demo: regeneration requested for ${requestedMood.primaryEmotion}${requestedMood.secondaryMoods.length ? ` (${requestedMood.secondaryMoods.join(", ")})` : ""}. Recommendations are not generated in this demo.`}
      </p>
    </>
  );
}
