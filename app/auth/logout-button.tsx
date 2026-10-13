"use client";

import { useActionState } from "react";
import { logoutAction } from "./actions";

export function LogoutButton() {
  const [, action, pending] = useActionState(logoutAction, undefined, "/");
  return <form action={action}><button type="submit" disabled={pending}>Log out</button></form>;
}
