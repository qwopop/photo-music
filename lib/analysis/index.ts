import "server-only";

import type { PaletteResult } from "../palette";
import { PaletteError } from "../palette";
import type { MoodResult } from "../mood";
import type { ConsumedUpload } from "../upload/store";
import { VisionError } from "../vision";
import { analysisRateLimiter, type AnalysisRateLimiter } from "./rate-limit";

export {
  ANALYSIS_REQUEST_LIMIT,
  ANALYSIS_WINDOW_MS,
  AnalysisRateLimiter,
  analysisRateLimiter,
  MAX_TRACKED_ANALYSIS_IPS,
} from "./rate-limit";

const MAX_REQUEST_BYTES = 1024;

type AnalysisErrorCode =
  | "INVALID_REQUEST"
  | "UPLOAD_NOT_FOUND"
  | "INVALID_IMAGE"
  | "FILE_TOO_LARGE"
  | "NO_VISIBLE_PIXELS"
  | "VISION_REFUSED"
  | "RATE_LIMITED"
  | "VISION_BAD_RESPONSE"
  | "VISION_UNAVAILABLE"
  | "VISION_NOT_CONFIGURED"
  | "ANALYSIS_FAILED";

const errorDetails: Record<AnalysisErrorCode, { status: number; message: string }> = {
  INVALID_REQUEST: { status: 400, message: "Send a JSON object with one upload handle." },
  UPLOAD_NOT_FOUND: { status: 404, message: "This upload has expired or is no longer available. Please upload your photo again." },
  INVALID_IMAGE: { status: 415, message: "Choose a valid JPEG, PNG, or WebP image." },
  FILE_TOO_LARGE: { status: 413, message: "The image must be at most 10 MiB." },
  NO_VISIBLE_PIXELS: { status: 422, message: "The image has no visible pixels." },
  VISION_REFUSED: { status: 422, message: "The photo could not be analyzed." },
  RATE_LIMITED: { status: 429, message: "Too many analysis requests. Please try again shortly." },
  VISION_BAD_RESPONSE: { status: 502, message: "Photo analysis returned an unusable answer. Please try again." },
  VISION_UNAVAILABLE: { status: 503, message: "Photo analysis is temporarily unavailable. Please try again shortly." },
  VISION_NOT_CONFIGURED: { status: 503, message: "Photo analysis is not set up on this server." },
  ANALYSIS_FAILED: { status: 500, message: "Photo analysis failed. Please try again." },
};

export interface AnalysisDependencies {
  readonly consumeUpload: (id: string) => ConsumedUpload | undefined;
  readonly extractPalette: (bytes: Buffer) => Promise<PaletteResult>;
  readonly analyze: (bytes: Buffer) => Promise<MoodResult>;
  readonly now?: () => number;
  readonly limiter?: AnalysisRateLimiter;
}

function errorResponse(
  code: AnalysisErrorCode,
  retryAfterSeconds?: number,
): Response {
  const { status, message } = errorDetails[code];
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (retryAfterSeconds !== undefined) headers.set("Retry-After", String(retryAfterSeconds));
  return Response.json({ error: { code, message } }, { status, headers });
}

function invalidRequest(): Response {
  return errorResponse("INVALID_REQUEST");
}

async function readRequestBody(request: Request): Promise<string | undefined> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    return undefined;
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request is already invalid; cancellation errors carry no useful response.
        }
        return undefined;
      }
      size += value.byteLength;
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function parseUploadHandle(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = Object.keys(value);
  if (fields.length !== 1 || fields[0] !== "upload") return undefined;
  const upload = (value as { upload?: unknown }).upload;
  return typeof upload === "string" ? upload : undefined;
}

function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const first = forwarded.split(",", 1)[0].trim();
  return first || "unknown";
}

function errorCode(error: unknown): AnalysisErrorCode {
  if (error instanceof PaletteError) {
    if (error.code === "NO_VISIBLE_PIXELS") return "NO_VISIBLE_PIXELS";
    if (error.code === "FILE_TOO_LARGE") return "FILE_TOO_LARGE";
    return "INVALID_IMAGE";
  }
  if (error instanceof VisionError) return error.code;
  return "ANALYSIS_FAILED";
}

export function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

export async function handleAnalysisRequest(
  request: Request,
  dependencies: AnalysisDependencies,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return invalidRequest();
  const body = await readRequestBody(request);
  if (body === undefined) return invalidRequest();
  const uploadId = parseUploadHandle(body);
  if (uploadId === undefined) return invalidRequest();

  const rateLimit = (dependencies.limiter ?? analysisRateLimiter).check(
    requestIp(request),
    dependencies.now?.(),
  );
  if (!rateLimit.allowed) return errorResponse("RATE_LIMITED", rateLimit.retryAfterSeconds);

  try {
    const upload = dependencies.consumeUpload(uploadId);
    if (!upload) return errorResponse("UPLOAD_NOT_FOUND");
    const palette = await dependencies.extractPalette(upload.bytes);
    const mood = await dependencies.analyze(upload.bytes);
    return Response.json({ mood, palette }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(errorCode(error));
  }
}
