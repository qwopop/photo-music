/** Drizzle wraps driver errors; inspect only structured fields, never its SQL-bearing message. */
export function isDuplicateEmail(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const value = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (value.code === "23505" && value.constraint === "users_email_lower_key") return true;
    current = value.cause;
  }
  return false;
}

/** Deliberately fixed text: exceptions can contain credentials, SQL and parameters. */
export function logAuthFailure(): void {
  console.error("Authentication operation failed; check the database configuration and connection.");
}
