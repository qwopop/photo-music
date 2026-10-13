"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestClientKey } from "../../lib/rate-limit/client-ip";
import { getClientIpConfig } from "../../lib/config";
import { login, logout, signup } from "../../lib/auth/service";
import type { AuthFormState } from "../../lib/auth/rules";
import { SESSION_COOKIE, SESSION_COOKIE_ATTRIBUTES } from "../../lib/auth/tokens";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The client key from the configured header only; null (with a fixed log line) when unusable. */
async function requestIp(): Promise<string | null> {
  const ip = requestClientKey(await headers(), getClientIpConfig().header);
  if (!ip) console.warn("Client IP header is missing or invalid; per-IP rate limits are skipped.");
  return ip;
}

export async function signupAction(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const jar = await cookies();
  const currentToken = jar.get(SESSION_COOKIE)?.value;
  if (currentToken !== undefined) jar.delete(SESSION_COOKIE);
  const result = await signup({ email: field(form, "email"), password: field(form, "password"), confirmPassword: field(form, "confirmPassword") }, currentToken, undefined, { ip: await requestIp() });
  if (!result.ok) return result.state;
  jar.set(SESSION_COOKIE, result.token, { ...SESSION_COOKIE_ATTRIBUTES, expires: result.expiresAt });
  redirect("/");
}

export async function loginAction(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const jar = await cookies();
  const currentToken = jar.get(SESSION_COOKIE)?.value;
  if (currentToken !== undefined) jar.delete(SESSION_COOKIE);
  const result = await login({ email: field(form, "email"), password: field(form, "password") }, currentToken, undefined, { ip: await requestIp() });
  if (!result.ok) return result.state;
  jar.set(SESSION_COOKIE, result.token, { ...SESSION_COOKIE_ATTRIBUTES, expires: result.expiresAt });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  await logout(jar.get(SESSION_COOKIE)?.value, () => jar.delete(SESSION_COOKIE));
  redirect("/");
}
