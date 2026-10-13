import { hash, verify } from "@node-rs/argon2";
import { normalizedPassword } from "./rules";

const settings = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(normalizedPassword(password), settings);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, normalizedPassword(password));
  } catch {
    // Corrupt stored credentials must not turn an invalid login into an error page.
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Lazy, process-local and fixed after first use, with the same work as real hashes. */
export function getDummyHash(): Promise<string> {
  return dummy ??= hashPassword("photo-music-dummy-password");
}
