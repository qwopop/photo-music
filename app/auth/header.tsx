import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { getCurrentUser } from "../../lib/auth";
import { logAuthFailure } from "../../lib/auth/errors";
import { LogoutButton } from "./logout-button";
import styles from "./styles.module.css";

async function AccountLinks() {
  let user;
  try {
    user = await getCurrentUser();
  } catch (error) {
    // Keep Next's dynamic/prerender control flow intact; catch only real outages.
    unstable_rethrow(error);
    logAuthFailure();
    user = null;
  }
  if (!user) return <><Link href="/login">Log in</Link><Link href="/signup">Sign up</Link></>;
  return <><span>Signed in as {user.email}</span><LogoutButton /></>;
}

export async function Header() {
  const account = await AccountLinks();
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>Photo Music</Link>
      <nav aria-label="Account" className={styles.account}>
        {account}
      </nav>
    </header>
  );
}
