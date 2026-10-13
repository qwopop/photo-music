import { NextResponse } from "next/server";
import { generateSocialContent, SocialError, createClaudeSocialClient } from "../../../lib/social";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "The request is invalid." } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const content = await generateSocialContent(body, createClaudeSocialClient());
    return NextResponse.json(content, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SocialError && error.code === "SOCIAL_INVALID_INPUT") {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const unavailable = error instanceof SocialError ? error : new SocialError("SOCIAL_UNAVAILABLE");
    return NextResponse.json(
      { error: { code: unavailable.code, message: unavailable.message } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
