import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configVariableNames } from "./schema";

/**
 * Compares the text of `.env.example` with the variables the config module
 * reads, and returns every disagreement (an empty list means they agree).
 * Every line must be blank, a `#` comment, or `NAME=` with an empty value and
 * a comment above it. Handles LF and CRLF line endings.
 */
function checkEnvExample(text: string, expected: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      problems.push(`line ${lineNumber} is neither a comment nor a NAME= line`);
      return;
    }
    const [, name, value] = match;
    if (value !== "") {
      problems.push(`${name} has a value; leave it empty (${name}=)`);
    }
    if (seen.has(name)) {
      problems.push(`${name} is listed more than once`);
    }
    if (!lines[index - 1]?.trim().startsWith("#")) {
      problems.push(`${name} has no comment above it`);
    }
    if (!expected.includes(name)) {
      problems.push(`${name} is not read by lib/config`);
    }
    seen.add(name);
  });

  for (const name of expected) {
    if (!seen.has(name)) {
      problems.push(`${name} is read by lib/config but missing from .env.example`);
    }
  }
  return problems;
}

const envExample = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
const lf = envExample.replace(/\r\n/g, "\n");
const crlf = lf.replace(/\n/g, "\r\n");

describe(".env.example", () => {
  it("lists exactly the variables lib/config reads, each once, with empty values", () => {
    expect(checkEnvExample(envExample, configVariableNames)).toEqual([]);
  });

  describe.each([
    ["LF", lf, "\n"],
    ["CRLF", crlf, "\r\n"],
  ])("with %s line endings", (_, text, eol) => {
    it("agrees with lib/config", () => {
      expect(checkEnvExample(text, configVariableNames)).toEqual([]);
    });

    it("fails when a variable lib/config reads is missing", () => {
      const changed = text.replace(`YOUTUBE_API_KEY=${eol}`, "");
      expect(changed).not.toBe(text);
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        "YOUTUBE_API_KEY is read by lib/config but missing from .env.example",
      ]);
    });

    it("fails when a variable is only in a comment", () => {
      const changed = text.replace(`${eol}DATABASE_URL=${eol}`, `${eol}# DATABASE_URL=${eol}`);
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        "DATABASE_URL is read by lib/config but missing from .env.example",
      ]);
    });

    it("fails for a variable lib/config does not read", () => {
      const changed = `${text}${eol}# Something else.${eol}FOO=${eol}`;
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        "FOO is not read by lib/config",
      ]);
    });

    it("fails for a duplicate", () => {
      const changed = `${text}${eol}# Again.${eol}VISION_API_KEY=${eol}`;
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        "VISION_API_KEY is listed more than once",
      ]);
    });

    it("fails for a non-empty value", () => {
      const changed = text.replace(`SPOTIFY_CLIENT_SECRET=${eol}`, `SPOTIFY_CLIENT_SECRET=abc${eol}`);
      expect(changed).not.toBe(text);
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        "SPOTIFY_CLIENT_SECRET has a value; leave it empty (SPOTIFY_CLIENT_SECRET=)",
      ]);
    });

    it("fails for a line that is not NAME=", () => {
      const changed = `${text}${eol}export S3_REGION=${eol}`;
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        `line ${changed.split(eol).length - 1} is neither a comment nor a NAME= line`,
      ]);
    });

    it("fails for a variable without a comment above it", () => {
      const changed = text.replace(`${eol}S3_BUCKET=${eol}`, `${eol}${eol}S3_BUCKET=${eol}`);
      expect(checkEnvExample(changed, configVariableNames)).toEqual([
        "S3_BUCKET has no comment above it",
      ]);
    });
  });
});
