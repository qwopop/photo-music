import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ConfigError, getVisionConfig } from "../config";
import { moodResultSchema } from "../mood";
import { VisionError } from "./errors";
import type { PreparedImage } from "./prepare";
import { MOOD_PROMPT } from "./prompt";

/** Everything the analyzer needs from a provider; tests and other code can replace it. */
export interface VisionClient {
  /** Returns the provider's parsed answer, unchecked. Throws a `VisionError` for known failures. */
  analyze(image: PreparedImage): Promise<unknown>;
}

export const VISION_MODEL = "claude-opus-5-5";
export const VISION_BASE_URL = "https://api.anthropic.com";
export const VISION_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 4096;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `fetch` and `timeoutMs` exist for tests only. */
export interface ClaudeVisionClientOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

// Only these request headers leave the process. This drops anything the SDK
// copies from ANTHROPIC_CUSTOM_HEADERS, such as an Authorization header.
const SENT_HEADERS = /^(accept|anthropic-.+|content-type|user-agent|x-stainless-.+)$/i;
// Provider headers cannot override the bounded retry policy below.
const IGNORED_RESPONSE_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"];

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function guardedFetch(base: Fetch, apiKey: string): Fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of [...headers.keys()]) if (!SENT_HEADERS.test(name)) headers.delete(name);
    headers.set("x-api-key", apiKey);

    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const pending = base(input, { ...init, headers });
    const response = await (signal ?
      new Promise<Response>((resolve, reject) => {
        // Honour the timeout even when the underlying fetch ignores its signal.
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
        pending.then(resolve, reject);
      })
    : pending);

    const kept = new Headers(response.headers);
    for (const name of IGNORED_RESPONSE_HEADERS) kept.delete(name);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: kept });
  };
}

/** Retry only transport failures, HTTP 429 and server errors, once. */
function isTransient(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    return error.status === 429 || (typeof error.status === "number" && error.status >= 500);
  }
  return false;
}

function toVisionError(error: unknown): VisionError {
  if (error instanceof VisionError) return new VisionError(error.code);
  if (error instanceof ConfigError) return new VisionError("VISION_NOT_CONFIGURED");
  if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) {
    return new VisionError("VISION_NOT_CONFIGURED");
  }
  return new VisionError("VISION_UNAVAILABLE");
}

/**
 * The real client: Claude through the Anthropic SDK. The key is read from
 * `lib/config` when an analysis runs, and the SDK gets explicit settings so it
 * ignores its own ANTHROPIC_* environment variables. Logs nothing.
 */
export function createClaudeVisionClient(options: ClaudeVisionClientOptions = {}): VisionClient {
  return {
    async analyze(image) {
      try {
        const { apiKey } = getVisionConfig();
        const client = new Anthropic({
          apiKey,
          authToken: null,
          baseURL: VISION_BASE_URL,
          logLevel: "off",
          timeout: options.timeoutMs ?? VISION_TIMEOUT_MS,
          maxRetries: 0, // The SDK also retries 408/409; our narrower policy is below.
          fetch: guardedFetch(options.fetch ?? ((input, init) => fetch(input, init)), apiKey),
        });

        // The output format comes from moodResultSchema. The SDK's own parsing is
        // replaced by a pass-through, so that stop_reason is checked first and
        // a cut-off or non-JSON answer maps to a VisionError, not an SDK error.
        const format = { ...betaZodOutputFormat(moodResultSchema), parse: (text: string) => text };
        const send = () => client.beta.messages.parse({
          model: VISION_MODEL,
          max_tokens: MAX_TOKENS,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") },
                },
                { type: "text", text: MOOD_PROMPT },
              ],
            },
          ],
        });

        let message;
        for (let attempt = 0; ; attempt += 1) {
          try {
            message = await send();
            break;
          } catch (error) {
            if (attempt === 0 && isTransient(error)) continue;
            throw error;
          }
        }

        if (message.stop_reason === "refusal") throw new VisionError("VISION_REFUSED");
        if (message.stop_reason !== "end_turn") throw new VisionError("VISION_BAD_RESPONSE");
        const text = message.content.find((block) => block.type === "text");
        if (!text || text.type !== "text") throw new VisionError("VISION_BAD_RESPONSE");
        try {
          return JSON.parse(text.text) as unknown;
        } catch {
          throw new VisionError("VISION_BAD_RESPONSE");
        }
      } catch (error) {
        throw toVisionError(error);
      }
    },
  };
}
