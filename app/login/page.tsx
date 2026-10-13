import { AuthForm } from "../auth/form";
import styles from "../auth/styles.module.css";

export default function LoginPage() {
  return <main className={styles.page}><h1>Log in</h1><AuthForm mode="login" /></main>;
}
