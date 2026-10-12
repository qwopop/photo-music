import { uploadErrorResponse } from "../../../lib/upload/errors";
import { readImageFile } from "../../../lib/upload/request";
import { uploadStore } from "../../../lib/upload/store";
import { validateImage } from "../../../lib/upload/validate";

// Cache Components uses Next.js's default Node.js runtime; an explicit runtime
// segment export is unsupported in this repository's Next.js configuration.

export async function POST(request: Request): Promise<Response> {
  try {
    const image = await validateImage(await readImageFile(request));
    const upload = uploadStore.put(image);
    return Response.json({ upload }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

// No HTTP method exposes an uploaded photo. Provide an explicit, uncacheable GET failure.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
