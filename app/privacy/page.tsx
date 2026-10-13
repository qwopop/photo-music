import { getCurrentUser } from "../../lib/auth";
import { DeleteAccountButton } from "./delete-account-button";

export default async function PrivacyPage() {
  const user = await getCurrentUser();
  return (
    <main>
      <h1>Privacy</h1>
      <p>Guest photos are processed temporarily and are not saved. If you save a photo while signed in, its private photo and result are stored in your account history.</p>
      <p>You can permanently delete an individual saved photo from your history or delete your account and all associated data below.</p>
      {user ? <DeleteAccountButton /> : <p><a href="/login">Sign in</a> to manage saved account data.</p>}
    </main>
  );
}
