import { describe, expect, it, vi } from "vitest";
import { deleteAccount, DeleteAccountDependencies } from "./delete-account";

const user = { id: "7a93c9ab-8389-48a0-a854-f063bb18406d", email: "user@example.com" };

function deps(overrides: Partial<DeleteAccountDependencies> = {}): DeleteAccountDependencies {
  return {
    getCurrentUser: vi.fn(async () => user),
    deleteUserPhotos: vi.fn(async () => 2),
    deleteUser: vi.fn(async () => true),
    ...overrides,
  };
}

describe("deleteAccount", () => {
  it("checks the current user before touching storage or data", async () => {
    const dependencies = deps({ getCurrentUser: vi.fn(async () => null) });
    expect(await deleteAccount(dependencies)).toMatchObject({ ok: false, code: "unauthorized" });
    expect(dependencies.deleteUserPhotos).not.toHaveBeenCalled();
    expect(dependencies.deleteUser).not.toHaveBeenCalled();
  });

  it("removes stored objects before deleting the user and cascading database rows", async () => {
    const order: string[] = [];
    const dependencies = deps({
      deleteUserPhotos: vi.fn(async () => { order.push("storage"); return 2; }),
      deleteUser: vi.fn(async () => { order.push("database"); return true; }),
    });
    expect(await deleteAccount(dependencies)).toEqual({ ok: true });
    expect(order).toEqual(["storage", "database"]);
    expect(dependencies.deleteUserPhotos).toHaveBeenCalledWith(user.id);
    expect(dependencies.deleteUser).toHaveBeenCalledWith(user.id);
  });

  it("keeps the account when object deletion fails and hides provider details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dependencies = deps({
      deleteUserPhotos: vi.fn(async () => { throw new Error("secret key"); }),
    });
    expect(await deleteAccount(dependencies)).toMatchObject({ ok: false, code: "unavailable" });
    expect(dependencies.deleteUser).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).not.toContain("secret key");
  });
});
