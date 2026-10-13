"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { deleteAccount } from "../../lib/privacy/delete-account";
import { SESSION_COOKIE } from "../../lib/auth/tokens";

export async function deleteAccountAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await deleteAccount();
  if (!result.ok) return { ok: false, message: result.message };
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
