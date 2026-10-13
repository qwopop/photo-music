import type { MoodResult } from "../mood";
import { PaletteError, extractPalette } from "../palette";
import type { ConsumedUpload } from "../upload/store";
import { VisionError } from "../vision/errors";
import type { RateLimitResult } from "./rate-limit";

export const MAX_BODY_BYTES = 1024;

export interface AnalyzeDependencies {
  analyze(bytes: Buffer): Promise<MoodResult>;
  consumeUpload(id: string): ConsumedUpload | undefined;
  limiter: { check(key: string): RateLimitResult };
}

const errors = {
  INVALID_REQUEST: [400, "Send a JSON body with the upload handle."],
  UPLOAD_NOT_FOUND: [404, "The upload was not found or has expired. Upload the photo again."],
  INVALID_IMAGE: [415, "The image could not be read. Choose a valid JPEG, PNG, or WebP image."],
  FILE_TOO_LARGE: [413, "The image must be at most 10 MiB."],
  NO_VISIBLE_PIXELS: [422, "The image has no visible pixels."],
  VISION_REFUSED: [422, "The photo could not be analyzed."],
  RATE_LIMITED: [429, "Too many requests. Please try again later."],
  VISION_BAD_RESPONSE: [502, "Photo analysis returned an unusable answer. Please try again."],
  VISION_UNAVAILABLE: [503, "Photo analysis is temporarily unavailable. Please try again shortly."],
  VISION_NOT_CONFIGURED: [503, "Photo analysis is not set up on this server."],
  ANALYSIS_FAILED: [500, "The photo could not be analyzed. Please try again."],
} as const;

type ErrorCode = keyof typeof errors;

function fail(code: ErrorCode, extra: Record<string, string> = {}): Response {
  const [status, message] = errors[code];
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

export function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
  return first || "unknown";
}

async function readHandle(request: Request): Promise<string | undefined> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) return undefined;
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const keys = Object.keys(parsed);
    const { upload } = parsed as { upload?: unknown };
    return keys.length === 1 && keys[0] === "upload" && typeof upload === "string" ? upload : undefined;
  } catch {
    return undefined;
  }
}

/** Order: body, rate limit, consume handle, palette (free), then the paid vision call. */
export async function handleAnalyze(request: Request, deps: AnalyzeDependencies): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    const handle = await readHandle(request);
    if (handle === undefined) return fail("INVALID_REQUEST");

    const limit = deps.limiter.check(clientIp(request));
    if (!limit.allowed) return fail("RATE_LIMITED", { "Retry-After": String(limit.retryAfterSeconds) });

    const upload = deps.consumeUpload(handle);
    if (!upload) return fail("UPLOAD_NOT_FOUND");

    const palette = await extractPalette(upload.bytes);
    const mood = await deps.analyze(upload.bytes);
    return Response.json({ mood, palette }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PaletteError || error instanceof VisionError) {
      if (error.code in errors) return fail(error.code);
    }
    return fail("ANALYSIS_FAILED");
  }
}
