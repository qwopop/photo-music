"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { login, logout, signup } from "../../lib/auth/service";
import type { AuthFormState } from "../../lib/auth/rules";
import { SESSION_COOKIE, SESSION_COOKIE_ATTRIBUTES } from "../../lib/auth/tokens";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function signupAction(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const jar = await cookies();
  const currentToken = jar.get(SESSION_COOKIE)?.value;
  if (currentToken !== undefined) jar.delete(SESSION_COOKIE);
  const result = await signup({ email: field(form, "email"), password: field(form, "password"), confirmPassword: field(form, "confirmPassword") }, currentToken);
  if (!result.ok) return result.state;
  jar.set(SESSION_COOKIE, result.token, { ...SESSION_COOKIE_ATTRIBUTES, expires: result.expiresAt });
  redirect("/");
}

export async function loginAction(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const jar = await cookies();
  const currentToken = jar.get(SESSION_COOKIE)?.value;
  if (currentToken !== undefined) jar.delete(SESSION_COOKIE);
  const result = await login({ email: field(form, "email"), password: field(form, "password") }, currentToken);
  if (!result.ok) return result.state;
  jar.set(SESSION_COOKIE, result.token, { ...SESSION_COOKIE_ATTRIBUTES, expires: result.expiresAt });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  await logout(jar.get(SESSION_COOKIE)?.value, () => jar.delete(SESSION_COOKIE));
  redirect("/");
}
