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

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const HEAD = methodNotAllowed;
