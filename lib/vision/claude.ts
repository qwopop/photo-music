import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ConfigError, getVisionConfig } from "../config";
import { moodResultSchema } from "../mood";
import { VisionError } from "./errors";
import type { PreparedImage } from "./prepare";
import { MOOD_PROMPT } from "./prompt";
import type { VisionClient } from "./index";

export const VISION_MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 4096;

export interface ClaudeVisionClientOptions {
  /** For tests only: replaces the network. */
  fetch?: typeof fetch;
  /** For tests only: per-attempt timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
}

/** Builds the real client. Nothing is read or opened until an analysis runs. */
export function createClaudeVisionClient(options: ClaudeVisionClientOptions = {}): VisionClient {
  return {
    async analyze(image: PreparedImage): Promise<unknown> {
      let apiKey: string;
      try {
        apiKey = getVisionConfig().apiKey;
      } catch (error) {
        throw new VisionError(error instanceof ConfigError ? "VISION_NOT_CONFIGURED" : "VISION_UNAVAILABLE");
      }

      // Explicit settings, so the SDK ignores its own ANTHROPIC_* variables and logs nothing.
      const sdk = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: "https://api.anthropic.com",
        logLevel: "off",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 1,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });

      // Keep the raw text: the answer is validated against moodResultSchema by
      // the caller, and a refusal must not surface as an SDK parse error.
      const format = betaZodOutputFormat(moodResultSchema);
      const rawFormat = { ...format, parse: (text: string) => text };

      let message;
      try {
        message = await sdk.beta.messages.parse({
          model: VISION_MODEL,
          max_tokens: MAX_TOKENS,
          output_config: { effort: "low", format: rawFormat },
          fallbacks: "default",
          betas: [FALLBACK_BETA],
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
      } catch (error) {
        const status = error instanceof Anthropic.APIError ? error.status : undefined;
        throw new VisionError(status === 401 || status === 403 ? "VISION_NOT_CONFIGURED" : "VISION_UNAVAILABLE");
      }

      if (message.stop_reason === "refusal") throw new VisionError("VISION_REFUSED");
      if (message.stop_reason !== "end_turn") throw new VisionError("VISION_BAD_RESPONSE");
      const block = message.content.find((item) => item.type === "text");
      if (!block) throw new VisionError("VISION_BAD_RESPONSE");
      try {
        return JSON.parse(block.text);
      } catch {
        throw new VisionError("VISION_BAD_RESPONSE");
      }
    },
  };
}
