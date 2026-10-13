"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AuthFormState } from "../../lib/auth/rules";
import { loginAction, signupAction } from "./actions";
import styles from "./styles.module.css";

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const signup = mode === "signup";
  const [state, action, pending] = useActionState(signup ? signupAction : loginAction, { email: "" } satisfies AuthFormState, `/${mode}`);
  const fields = [
    { name: "email" as const, label: "Email", type: "email", autocomplete: "email" },
    { name: "password" as const, label: "Password", type: "password", autocomplete: signup ? "new-password" : "current-password" },
    ...(signup ? [{ name: "confirmPassword" as const, label: "Confirm password", type: "password", autocomplete: "new-password" }] : []),
  ];
  return (
    <form action={action} noValidate className={styles.form}>
      {state.message && <p className={styles.error} role="alert">{state.message}{state.duplicate && <> <Link href="/login">Log in</Link></>}</p>}
      {fields.map(({ name, label, type, autocomplete }) => (
        <div className={styles.field} key={name}>
          <label htmlFor={`${mode}-${name}`}>{label}</label>
          <input id={`${mode}-${name}`} name={name} type={type} autoComplete={autocomplete}
            defaultValue={name === "email" ? state.email : ""}
            aria-invalid={state.errors?.[name] ? true : undefined}
            aria-describedby={state.errors?.[name] ? `${mode}-${name}-error` : undefined} />
          {state.errors?.[name] && <p id={`${mode}-${name}-error`} className={styles.error}>{state.errors[name]}</p>}
        </div>
      ))}
      <button type="submit" disabled={pending}>{signup ? "Sign up" : "Log in"}</button>
      <p>{signup ? "Already have an account?" : "New to Photo Music?"} <Link href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Sign up"}</Link></p>
    </form>
  );
}
