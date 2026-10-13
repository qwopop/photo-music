import { z } from "zod";
import { formatMinutes } from "../rate-limit";

export const messages = {
  emailRequired: "Enter your email address.",
  emailInvalid: "Enter a valid email address, like name@example.com.",
  passwordRequired: "Enter a password.",
  loginPasswordRequired: "Enter your password.",
  passwordShort: "Use at least 8 characters.",
  passwordLong: "Use at most 128 characters.",
  passwordMismatch: "The passwords do not match.",
  duplicate: "An account with this email already exists.",
  incorrect: "Email or password is incorrect.",
  failure: "Something went wrong. Please try again.",
} as const;

export function tooManyAttempts(retryAfterMs: number): string {
  return `Too many attempts. Try again in ${formatMinutes(retryAfterMs)}.`;
}

export type FieldErrors = Partial<Record<"email" | "password" | "confirmPassword", string>>;
/** Only safe form state travels back to React. Never include passwords. */
export interface AuthFormState {
  email: string;
  errors?: FieldErrors;
  message?: string;
  duplicate?: boolean;
}
export interface Credentials { email: string; password: string }
export interface SignupInput extends Credentials { confirmPassword: string }

export function normalizedPassword(password: string): string {
  return password.normalize("NFKC");
}
export function passwordLength(password: string): number {
  return Array.from(normalizedPassword(password)).length;
}

export function validateSignup(input: SignupInput): FieldErrors {
  const email = input.email.trim();
  const errors: FieldErrors = {};
  if (!email) errors.email = messages.emailRequired;
  else if (email.length > 254 || !z.email().safeParse(email).success) errors.email = messages.emailInvalid;
  const length = passwordLength(input.password);
  if (!length) errors.password = messages.passwordRequired;
  else if (length < 8) errors.password = messages.passwordShort;
  else if (length > 128) errors.password = messages.passwordLong;
  if (normalizedPassword(input.password) !== normalizedPassword(input.confirmPassword)) {
    errors.confirmPassword = messages.passwordMismatch;
  }
  return errors;
}

export function validateLogin(input: Credentials): { errors: FieldErrors; overlong: boolean } {
  const errors: FieldErrors = {};
  if (!input.email.trim()) errors.email = messages.emailRequired;
  if (!input.password) errors.password = messages.loginPasswordRequired;
  return { errors, overlong: input.email.trim().length > 254 || passwordLength(input.password) > 128 };
}
