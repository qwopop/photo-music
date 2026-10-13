import {
  handleAnalysisRequest,
  methodNotAllowed,
} from "../../../lib/analysis";
import { extractPalette } from "../../../lib/palette";
import { analyzePhotoMood, createClaudeVisionClient } from "../../../lib/vision";
import { consumeUpload } from "../../../lib/upload/store";

export function POST(request: Request): Promise<Response> {
  return handleAnalysisRequest(request, {
    consumeUpload,
    extractPalette,
    analyze: (bytes) => analyzePhotoMood(bytes, createClaudeVisionClient()),
  });
}

export function GET(): Response {
  return methodNotAllowed();
}

export function PUT(): Response {
  return methodNotAllowed();
}

export function PATCH(): Response {
  return methodNotAllowed();
}

export function DELETE(): Response {
  return methodNotAllowed();
}

export function OPTIONS(): Response {
  return methodNotAllowed();
}
