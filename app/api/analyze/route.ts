import { handleAnalyze } from "../../../lib/analysis/handler";
import { analyzeRateLimiter } from "../../../lib/analysis/rate-limit";
import { consumeUpload } from "../../../lib/upload/store";
import { analyzePhotoMood, createClaudeVisionClient } from "../../../lib/vision";

export function POST(request: Request): Promise<Response> {
  return handleAnalyze(request, {
    analyze: (bytes) => analyzePhotoMood(bytes, createClaudeVisionClient()),
    consumeUpload,
    limiter: analyzeRateLimiter,
  });
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
