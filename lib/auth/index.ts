import "server-only";

import { cookies } from "next/headers";
import { currentUser } from "./service";
import { SESSION_COOKIE } from "./tokens";

/** Call only during a request, never in a cache. A database outage throws. */
export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  return currentUser((await cookies()).get(SESSION_COOKIE)?.value);
}
