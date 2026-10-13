import "server-only";

import { eq } from "drizzle-orm";
import { getCurrentUser } from "../auth";
import { getDb } from "../db";
import { users } from "../db/schema";
import { deleteUserPhotos } from "../storage";

export type DeleteAccountState =
  | { ok: true }
  | { ok: false; code: "unauthorized" | "unavailable"; message: string };

export interface DeleteAccountDependencies {
  getCurrentUser: typeof getCurrentUser;
  deleteUserPhotos: typeof deleteUserPhotos;
  deleteUser: (userId: string) => Promise<boolean>;
}

const defaults: DeleteAccountDependencies = {
  getCurrentUser,
  deleteUserPhotos,
  async deleteUser(userId) {
    const [deleted] = await getDb().delete(users).where(eq(users.id, userId)).returning({ id: users.id });
    return Boolean(deleted);
  },
};

export async function deleteAccount(deps: DeleteAccountDependencies = defaults): Promise<DeleteAccountState> {
  let user;
  try {
    user = await deps.getCurrentUser();
  } catch {
    return { ok: false, code: "unavailable", message: "Account deletion failed. Please try again." };
  }
  if (!user) return { ok: false, code: "unauthorized", message: "Sign in to delete your account." };

  try {
    await deps.deleteUserPhotos(user.id);
    const deleted = await deps.deleteUser(user.id);
    return deleted
      ? { ok: true }
      : { ok: false, code: "unavailable", message: "Account deletion failed. Please try again." };
  } catch {
    console.error("Account deletion failed.");
    return { ok: false, code: "unavailable", message: "Account deletion failed. Please try again." };
  }
}
